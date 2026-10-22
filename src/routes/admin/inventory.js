'use strict';
const express = require('express');
const inventory = require('../../services/inventory');
const util = require('../../lib/util');
const infra = require('../../lib/infra');
const router = express.Router();
const db = req => req.app.locals.db;

router.get('/', (req, res) => {
  const d = db(req);
  const filter = ['low', 'out'].includes(req.query.show) ? req.query.show : 'all';
  const q = util.clean(req.query.q, 80);
  let rows = d.prepare(`SELECT v.*, p.name AS product_name, p.status AS product_status, b.name AS brand_name
    FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN brands b ON b.id = p.brand_id
    WHERE p.status != 'archived' AND v.active = 1 AND (? = '' OR p.name LIKE '%' || ? || '%' OR v.sku LIKE '%' || ? || '%' OR b.name LIKE '%' || ? || '%')
    ORDER BY p.name, v.size_ml`).all(q, q, q, q);
  rows = rows.map(r => ({ ...r, available: r.on_hand - r.reserved }));
  if (filter === 'low') rows = rows.filter(r => r.available > 0 && r.available <= r.low_stock_threshold);
  if (filter === 'out') rows = rows.filter(r => r.available <= 0);
  res.admin('inventory', { pageTitle: 'Inventory', rows, filter, q, val: inventory.valuation(d) });
});

router.get('/movements', (req, res) => {
  const d = db(req);
  const variantId = util.int(req.query.variant) || null;
  const type = util.clean(req.query.type, 20);
  const page = Math.max(1, util.int(req.query.page, 1));
  const where = ['1=1'], params = [];
  if (variantId) { where.push('m.variant_id = ?'); params.push(variantId); }
  if (type) { where.push('m.type = ?'); params.push(type); }
  const total = d.prepare(`SELECT COUNT(*) c FROM stock_movements m WHERE ${where.join(' AND ')}`).get(...params).c;
  const rows = d.prepare(`SELECT m.*, p.name AS product_name, v.label, v.sku, u.name AS user_name FROM stock_movements m
    JOIN product_variants v ON v.id = m.variant_id JOIN products p ON p.id = v.product_id LEFT JOIN users u ON u.id = m.user_id
    WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT 100 OFFSET ?`).all(...params, (page - 1) * 100);
  if (req.query.format === 'csv') {
    return infra.sendCsv(res, 'stock-movements.csv', ['When (UTC)', 'Product', 'Size', 'SKU', 'Type', 'On hand change', 'Reserved change', 'On hand after', 'Reserved after', 'Unit cost', 'Reference', 'Reason', 'User'],
      rows.map(r => [r.created_at, r.product_name, r.label, r.sku, r.type, r.on_hand_change, r.reserved_change, r.on_hand_after, r.reserved_after, r.unit_cost === null ? '' : util.fromPesewas(r.unit_cost), r.reference, r.reason, r.user_name]));
  }
  res.admin('movements', { pageTitle: 'Stock movements', rows, variantId, type, page, pages: Math.ceil(total / 100) || 1, total });
});

router.post('/adjust', (req, res) => {
  const d = db(req);
  const variantId = util.int(req.body.variantId);
  const qty = Math.abs(util.int(req.body.qty));
  const dir = req.body.direction === 'remove' ? -1 : 1;
  const kind = req.body.kind === 'damage' ? 'damage' : 'adjustment';
  const reason = util.clean(req.body.reason, 300);
  try {
    if (!qty) throw new inventory.StockError('Enter how many units.', variantId);
    inventory.adjustStock(d, variantId, kind === 'damage' ? -qty : dir * qty, reason, req.staff.id, kind);
    infra.audit(req, 'stock_adjusted', 'variant', variantId, `${kind} ${kind === 'damage' ? -qty : dir * qty}: ${reason}`);
    res.flash('success', 'Stock updated and recorded.');
  } catch (e) {
    if (e instanceof inventory.StockError) res.flash('error', e.message); else throw e;
  }
  res.redirect(typeof req.body.back === 'string' && req.body.back.startsWith('/admin') ? req.body.back : '/admin/inventory');
});

router.post('/count', (req, res) => {
  const d = db(req);
  const variantId = util.int(req.body.variantId);
  const counted = req.body.counted === '' ? NaN : util.int(req.body.counted, NaN);
  try {
    if (!Number.isInteger(counted) || counted < 0) throw new inventory.StockError('Enter the number you counted on the shelf.', variantId);
    const delta = inventory.stockCount(d, variantId, counted, util.clean(req.body.reason, 300), req.staff.id);
    infra.audit(req, 'stock_counted', 'variant', variantId, `counted ${counted}, difference ${delta}`);
    res.flash('success', delta === 0 ? 'Count matches the system. Nothing to change.' : `Stock corrected by ${delta > 0 ? '+' : ''}${delta}.`);
  } catch (e) {
    if (e instanceof inventory.StockError) res.flash('error', e.message); else throw e;
  }
  res.redirect('/admin/inventory');
});

module.exports = router;
