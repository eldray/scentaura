'use strict';
const express = require('express');
const inventory = require('../../services/inventory');
const reports = require('../../services/reports');
const util = require('../../lib/util');
const infra = require('../../lib/infra');
const router = express.Router();
const db = req => req.app.locals.db;

function supplierInput(b) {
  return { name: util.clean(b.name, 120), contact_person: util.clean(b.contact_person, 100), phone: util.clean(b.phone, 40), email: util.clean(b.email, 254),
    address: util.clean(b.address, 300), authenticity_notes: util.clean(b.authenticity_notes, 1500), active: b.active ? 1 : 0 };
}

router.get('/', (req, res) => {
  const d = db(req);
  res.admin('suppliers', { pageTitle: 'Suppliers & purchasing', balances: reports.supplierBalances(d), suppliers: d.prepare('SELECT * FROM suppliers ORDER BY name').all(),
    recent: d.prepare(`SELECT po.*, s.name AS supplier_name, (SELECT COALESCE(SUM(qty_ordered * unit_cost),0) FROM purchase_items WHERE purchase_order_id = po.id) AS value
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id ORDER BY po.id DESC LIMIT 15`).all() });
});

router.get('/new', (req, res) => res.admin('supplier-form', { pageTitle: 'Add supplier', s: { active: 1 }, isNew: true }));

router.post('/new', (req, res) => {
  const v = supplierInput({ ...req.body, active: '1' });
  if (v.name.length < 2) { res.flash('error', 'Enter the supplier name.'); return res.redirect('/admin/suppliers/new'); }
  const id = Number(db(req).prepare('INSERT INTO suppliers (name, contact_person, phone, email, address, authenticity_notes, active) VALUES (?,?,?,?,?,?,?)')
    .run(v.name, v.contact_person, v.phone, v.email, v.address, v.authenticity_notes, 1).lastInsertRowid);
  infra.audit(req, 'supplier_created', 'supplier', id, v.name);
  res.redirect(`/admin/suppliers/${id}`);
});

/* ----- purchase orders (declared before /:id) ----- */
router.get('/purchases/new', (req, res) => {
  const d = db(req);
  res.admin('purchase-form', { pageTitle: 'New purchase order', suppliers: d.prepare('SELECT id, name FROM suppliers WHERE active = 1 ORDER BY name').all(), supplierId: util.int(req.query.supplier),
    variants: d.prepare(`SELECT v.id, v.label, v.sku, v.cost, v.price, p.name FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.status != 'archived' ORDER BY p.name, v.size_ml`).all() });
});

router.post('/purchases', (req, res) => {
  const d = db(req);
  const supplierId = util.int(req.body.supplier_id);
  const ids = [].concat(req.body.variant_id || []), qtys = [].concat(req.body.qty || []), costs = [].concat(req.body.unit_cost || []);
  const lines = [];
  ids.forEach((id, i) => {
    const vid = util.int(id), qty = util.int(qtys[i]), cost = util.toPesewas(costs[i]);
    if (vid && qty > 0 && cost !== null) lines.push({ vid, qty, cost });
  });
  if (!d.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplierId) || !lines.length) {
    res.flash('error', 'Choose a supplier and add at least one item with a quantity and cost.');
    return res.redirect('/admin/suppliers/purchases/new');
  }
  const id = d.transaction(() => {
    let ref, n = 0;
    do { ref = `PO-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${util.randomCode(3)}`; n++; } while (d.prepare('SELECT 1 FROM purchase_orders WHERE reference = ?').get(ref) && n < 5);
    const poId = Number(d.prepare('INSERT INTO purchase_orders (supplier_id, reference, supplier_invoice, order_date, notes, created_by) VALUES (?,?,?,?,?,?)')
      .run(supplierId, ref, util.clean(req.body.supplier_invoice, 60) || null, /^\d{4}-\d{2}-\d{2}$/.test(req.body.order_date || '') ? req.body.order_date : new Date().toISOString().slice(0, 10), util.clean(req.body.notes, 500) || null, req.staff.id).lastInsertRowid);
    const ins = d.prepare('INSERT INTO purchase_items (purchase_order_id, variant_id, qty_ordered, unit_cost) VALUES (?,?,?,?)');
    lines.forEach(l => ins.run(poId, l.vid, l.qty, l.cost));
    return poId;
  })();
  infra.audit(req, 'purchase_created', 'purchase', id);
  res.redirect(`/admin/suppliers/purchases/${id}`);
});

function loadPo(d, id) {
  const po = d.prepare('SELECT po.*, s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?').get(id);
  if (!po) return null;
  po.items = d.prepare(`SELECT pi.*, p.name AS product_name, v.label, v.sku, v.price, v.cost AS avg_cost FROM purchase_items pi
    JOIN product_variants v ON v.id = pi.variant_id JOIN products p ON p.id = v.product_id WHERE pi.purchase_order_id = ? ORDER BY pi.id`).all(id);
  po.value = po.items.reduce((a, i) => a + i.qty_ordered * i.unit_cost, 0);
  po.receivedValue = po.items.reduce((a, i) => a + i.qty_received * i.unit_cost, 0);
  po.paid = d.prepare('SELECT COALESCE(SUM(amount),0) s FROM supplier_payments WHERE purchase_order_id = ?').get(id).s;
  po.payments = d.prepare('SELECT * FROM supplier_payments WHERE purchase_order_id = ? ORDER BY id DESC').all(id);
  return po;
}

router.get('/purchases/:id', (req, res) => {
  const po = loadPo(db(req), util.int(req.params.id));
  if (!po) return res.redirect('/admin/suppliers');
  res.admin('purchase', { pageTitle: `Purchase ${po.reference}`, po });
});

/** Stock only changes here, when goods actually arrive. */
router.post('/purchases/:id/receive', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  const po = loadPo(d, id);
  if (!po || ['received', 'cancelled'].includes(po.status)) return res.redirect(`/admin/suppliers/purchases/${id}`);
  let received = 0;
  try {
    d.transaction(() => {
      for (const it of po.items) {
        const qty = util.int(req.body[`recv_${it.id}`]);
        if (!(qty > 0)) continue;
        if (qty > it.qty_ordered - it.qty_received) throw new inventory.StockError(`You cannot receive more than was ordered for ${it.product_name}.`, it.variant_id);
        inventory.receiveStock(d, it.variant_id, qty, it.unit_cost, { reference: po.reference, userId: req.staff.id, batch: util.clean(req.body[`batch_${it.id}`], 40) || null, expiry: /^\d{4}-\d{2}-\d{2}$/.test(req.body[`exp_${it.id}`] || '') ? req.body[`exp_${it.id}`] : null, reason: `Received on ${po.reference}` });
        d.prepare('UPDATE purchase_items SET qty_received = qty_received + ?, batch_no = COALESCE(?, batch_no), expiry_date = COALESCE(?, expiry_date) WHERE id = ?')
          .run(qty, util.clean(req.body[`batch_${it.id}`], 40) || null, /^\d{4}-\d{2}-\d{2}$/.test(req.body[`exp_${it.id}`] || '') ? req.body[`exp_${it.id}`] : null, it.id);
        received += qty;
      }
      if (!received) throw new inventory.StockError('Enter the quantity you received for at least one item.', null);
      const left = d.prepare('SELECT COALESCE(SUM(qty_ordered - qty_received),0) s FROM purchase_items WHERE purchase_order_id = ?').get(id).s;
      d.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(left === 0 ? 'received' : 'partial', id);
    })();
    infra.audit(req, 'purchase_received', 'purchase', id, `${received} units`);
    res.flash('success', 'Stock received and costs updated.');
  } catch (e) { if (e instanceof inventory.StockError) res.flash('error', e.message); else throw e; }
  res.redirect(`/admin/suppliers/purchases/${id}`);
});

router.post('/purchases/:id/pay', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  const po = d.prepare('SELECT supplier_id FROM purchase_orders WHERE id = ?').get(id);
  const amount = util.toPesewas(req.body.amount);
  if (!po || !amount) { res.flash('error', 'Enter the amount paid, for example 1200.00.'); return res.redirect(`/admin/suppliers/purchases/${id}`); }
  d.prepare('INSERT INTO supplier_payments (supplier_id, purchase_order_id, amount, paid_on, method, note, created_by) VALUES (?,?,?,?,?,?,?)')
    .run(po.supplier_id, id, amount, /^\d{4}-\d{2}-\d{2}$/.test(req.body.paid_on || '') ? req.body.paid_on : new Date().toISOString().slice(0, 10), util.clean(req.body.method, 40), util.clean(req.body.note, 200), req.staff.id);
  infra.audit(req, 'supplier_payment', 'purchase', id, String(amount));
  res.flash('success', 'Payment recorded.');
  res.redirect(`/admin/suppliers/purchases/${id}`);
});

router.post('/purchases/:id/cancel', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  const po = d.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(id);
  if (po && po.status === 'pending') { d.prepare("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?").run(id); infra.audit(req, 'purchase_cancelled', 'purchase', id); res.flash('success', 'Purchase order cancelled.'); }
  else res.flash('error', 'Only orders where nothing has been received can be cancelled.');
  res.redirect(`/admin/suppliers/purchases/${id}`);
});

/* ----- a single supplier ----- */
router.get('/:id', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  const s = d.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
  if (!s) return res.redirect('/admin/suppliers');
  const bal = reports.supplierBalances(d).find(b => b.id === id);
  res.admin('supplier-form', { pageTitle: s.name, s, isNew: false, bal,
    pos: d.prepare(`SELECT po.*, (SELECT COALESCE(SUM(qty_ordered*unit_cost),0) FROM purchase_items WHERE purchase_order_id = po.id) AS value FROM purchase_orders po WHERE supplier_id = ? ORDER BY id DESC`).all(id),
    payments: d.prepare('SELECT * FROM supplier_payments WHERE supplier_id = ? ORDER BY id DESC LIMIT 30').all(id) });
});

router.post('/:id', (req, res) => {
  const v = supplierInput(req.body), id = util.int(req.params.id);
  if (v.name.length < 2) { res.flash('error', 'Enter the supplier name.'); return res.redirect(`/admin/suppliers/${id}`); }
  db(req).prepare('UPDATE suppliers SET name=?, contact_person=?, phone=?, email=?, address=?, authenticity_notes=?, active=? WHERE id=?')
    .run(v.name, v.contact_person, v.phone, v.email, v.address, v.authenticity_notes, v.active, id);
  infra.audit(req, 'supplier_updated', 'supplier', id, v.name);
  res.flash('success', 'Supplier saved.');
  res.redirect(`/admin/suppliers/${id}`);
});

module.exports = router;
