'use strict';
const express = require('express');
const orders = require('../../services/orders');
const payments = require('../../services/payments');
const momo = require('../../services/momo');
const notify = require('../../services/notify');
const util = require('../../lib/util');
const infra = require('../../lib/infra');
const router = express.Router();
const db = req => req.app.locals.db;

function ordersQuery(req) {
  const where = ['1=1'], params = [];
  const q = util.clean(req.query.q, 80);
  if (q) { where.push('(o.order_no LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ? OR o.customer_email LIKE ?)'); const l = `%${q}%`; params.push(l, l, l, l); }
  const status = util.clean(req.query.status, 30);
  if (status === 'awaiting_dispatch') where.push("(o.status IN ('paid','processing','packed') OR (o.payment_method = 'cod' AND o.status = 'pending_confirmation'))");
  else if (status === 'attention') where.push('o.needs_attention IS NOT NULL');
  else if (util.ORDER_STATUSES[status]) { where.push('o.status = ?'); params.push(status); }
  const pay = util.clean(req.query.payment, 20);
  if (['unpaid', 'pending', 'paid', 'failed', 'cancelled', 'partially_refunded', 'refunded'].includes(pay)) { where.push('o.payment_status = ?'); params.push(pay); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) { where.push('o.created_at >= ?'); params.push(req.query.from + ' 00:00:00'); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) { where.push('o.created_at <= ?'); params.push(req.query.to + ' 23:59:59'); }
  return { where: where.join(' AND '), params, q, status, pay };
}

router.get('/', (req, res) => {
  const d = db(req);
  const { where, params, q, status, pay } = ordersQuery(req);
  const page = Math.max(1, util.int(req.query.page, 1));
  const total = d.prepare(`SELECT COUNT(*) c FROM orders o WHERE ${where}`).get(...params).c;
  const rows = d.prepare(`SELECT o.* FROM orders o WHERE ${where} ORDER BY o.id DESC LIMIT 50 OFFSET ?`).all(...params, (page - 1) * 50);
  if (req.query.format === 'csv') {
    const all = d.prepare(`SELECT o.* FROM orders o WHERE ${where} ORDER BY o.id DESC LIMIT 5000`).all(...params);
    return infra.sendCsv(res, 'orders.csv', ['Order', 'Date (UTC)', 'Customer', 'Phone', 'Email', 'Zone', 'Delivery', 'Subtotal', 'Discount', 'Delivery fee', 'Total', 'Payment method', 'Payment status', 'Status'],
      all.map(o => [o.order_no, o.created_at, o.customer_name, o.customer_phone, o.customer_email, o.zone_name, o.delivery_name, util.fromPesewas(o.subtotal), util.fromPesewas(o.discount), util.fromPesewas(o.delivery_fee), util.fromPesewas(o.total), o.payment_method, o.payment_status, util.ORDER_STATUSES[o.status]]));
  }
  res.admin('orders', { pageTitle: 'Orders', rows, total, page, pages: Math.ceil(total / 50) || 1, q, status, pay, from: req.query.from || '', to: req.query.to || '' });
});

function detail(req, o) {
  const d = db(req);
  return {
    o, items: orders.getItems(d, o.id),
    events: d.prepare('SELECT e.*, u.name AS user_name FROM order_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.order_id = ? ORDER BY e.id DESC').all(o.id),
    payments: d.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC').all(o.id),
    refunds: d.prepare('SELECT r.*, u.name AS user_name FROM refunds r LEFT JOIN users u ON u.id = r.user_id WHERE r.order_id = ? ORDER BY r.id DESC').all(o.id),
    couriers: d.prepare('SELECT * FROM couriers WHERE active = 1 ORDER BY name').all(),
    next: orders.NEXT[o.status] || [], refundable: o.total - payments.refundedSoFar(d, o.id),
    canRefund: infra.can(req.staff.role, 'refunds'), canPayments: infra.can(req.staff.role, 'payments')
  };
}

router.get('/:id', (req, res) => {
  const o = orders.getOrder(db(req), util.int(req.params.id));
  if (!o) return res.status(404).admin('forbidden', { pageTitle: 'Order not found' });
  res.admin('order', { pageTitle: `Order ${o.order_no}`, ...detail(req, o) });
});

router.get('/:id/print', (req, res) => {
  const o = orders.getOrder(db(req), util.int(req.params.id));
  if (!o) return res.status(404).send('Not found');
  res.render('admin/packing-slip', { ...res.locals, o, items: orders.getItems(db(req), o.id) });
});

function back(res, id) { return res.redirect(`/admin/orders/${id}`); }

router.post('/:id/status', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  try {
    const o = orders.setStatus(d, id, util.clean(req.body.status, 30), { userId: req.staff.id, note: util.clean(req.body.note, 300) || null, restock: req.body.restock === '1' });
    infra.audit(req, 'order_status', 'order', id, `→ ${o.status}`);
    notify.statusChanged(d, o);
    res.flash('success', `Order is now “${util.ORDER_STATUSES[o.status]}”.`);
  } catch (e) { if (e instanceof orders.OrderError || e.name === 'StockError') res.flash('error', e.message); else throw e; }
  back(res, id);
});

router.post('/:id/shipping', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  const courier = util.int(req.body.courier_id) || null;
  d.prepare("UPDATE orders SET courier_id = ?, tracking_no = ?, updated_at = datetime('now') WHERE id = ?").run(courier, util.clean(req.body.tracking_no, 80) || null, id);
  orders.addEvent(d, id, { kind: 'note', note: `Courier/tracking updated${req.body.tracking_no ? ': ' + util.clean(req.body.tracking_no, 80) : ''}`, userId: req.staff.id });
  infra.audit(req, 'order_shipping', 'order', id);
  res.flash('success', 'Courier details saved.');
  back(res, id);
});

router.post('/:id/attempt', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  const note = util.clean(req.body.note, 300);
  if (!note) { res.flash('error', 'Say what happened (for example “Customer not reachable”).'); return back(res, id); }
  orders.addEvent(d, id, { kind: 'delivery_attempt', note: `Failed delivery attempt: ${note}`, userId: req.staff.id });
  res.flash('success', 'Failed attempt recorded.');
  back(res, id);
});

router.post('/:id/note', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  const note = util.clean(req.body.note, 500);
  if (note) orders.addEvent(d, id, { kind: 'note', note, userId: req.staff.id });
  back(res, id);
});

router.post('/:id/clear-flag', (req, res) => {
  db(req).prepare('UPDATE orders SET needs_attention = NULL WHERE id = ?').run(util.int(req.params.id));
  infra.audit(req, 'flag_cleared', 'order', req.params.id);
  back(res, req.params.id);
});

router.post('/:id/collect-cod', (req, res) => {
  const id = util.int(req.params.id);
  try {
    payments.collectCod(db(req), id, req.staff.id);
    infra.audit(req, 'cod_collected', 'order', id);
    res.flash('success', 'Cash recorded as collected. The order is now paid.');
  } catch (e) { if (e instanceof orders.OrderError) res.flash('error', e.message); else throw e; }
  back(res, id);
});

router.post('/:id/check-payment', async (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  const p = d.prepare("SELECT reference, provider FROM payments WHERE order_id = ? AND provider IN ('paystack','momo') AND status IN ('pending','abandoned') ORDER BY id DESC LIMIT 1").get(id);
  if (!p) res.flash('info', 'There is no pending online payment to check.');
  else {
    const name = p.provider === 'momo' ? 'MTN MoMo' : 'Paystack';
    const r = p.provider === 'momo' ? await momo.verifyReference(d, p.reference) : await payments.verifyReference(d, p.reference);
    res.flash(r.status === 'success' ? 'success' : 'info', r.status === 'success' ? `${name} confirms the payment. Order marked as paid.` : `${name} says: ${r.status}.`);
  }
  back(res, id);
});

router.post('/:id/refund', async (req, res) => {
  if (!infra.can(req.staff.role, 'refunds')) return res.status(403).admin('forbidden', { pageTitle: 'Not allowed' });
  const d = db(req), id = util.int(req.params.id);
  const amount = util.toPesewas(req.body.amount);
  try {
    if (amount === null) throw new orders.OrderError('Enter the refund amount, for example 150.00.');
    const r = await payments.refundOrder(d, id, amount, util.clean(req.body.reason, 300), req.staff.id, req.body.method === 'manual' ? 'manual' : 'paystack');   // Mobile Money payments are always refunded by hand
    infra.audit(req, 'refund', 'order', id, `${amount} (${r.method}, ${r.status})`);
    res.flash('success', r.status === 'processed' ? 'Refund recorded.' : 'Refund sent to Paystack. It is pending until Paystack confirms it.');
  } catch (e) { if (e instanceof orders.OrderError) res.flash('error', e.message); else throw e; }
  back(res, id);
});

module.exports = router;
