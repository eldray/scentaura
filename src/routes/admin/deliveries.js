'use strict';
const express = require('express');
const util = require('../../lib/util');
const infra = require('../../lib/infra');
const router = express.Router();
const db = req => req.app.locals.db;
const METHODS = { standard: 'Standard delivery', express: 'Express delivery', courier: 'Courier delivery', pickup: 'Customer pickup', collection_point: 'Collection point' };

router.get('/', (req, res) => {
  const d = db(req);
  const zones = d.prepare('SELECT * FROM delivery_zones ORDER BY sort, name').all();
  const rates = d.prepare('SELECT r.*, c.name AS courier_name FROM delivery_rates r LEFT JOIN couriers c ON c.id = r.courier_id ORDER BY r.zone_id, r.fee').all();
  zones.forEach(z => { z.rates = rates.filter(r => r.zone_id === z.id); });
  res.admin('deliveries', {
    pageTitle: 'Deliveries', zones, METHODS, couriers: d.prepare('SELECT * FROM couriers ORDER BY name').all(),
    inTransit: d.prepare("SELECT o.*, c.name AS courier_name, (SELECT COUNT(*) FROM order_events e WHERE e.order_id = o.id AND e.kind = 'delivery_attempt') AS attempts FROM orders o LEFT JOIN couriers c ON c.id = o.courier_id WHERE o.status IN ('paid','processing','packed','dispatched','out_for_delivery') OR (o.payment_method = 'cod' AND o.status = 'pending_confirmation') ORDER BY o.id").all()
  });
});

router.post('/zones', (req, res) => {
  const name = util.clean(req.body.name, 80);
  if (name.length < 2) { res.flash('error', 'Enter a zone name.'); return res.redirect('/admin/deliveries'); }
  try {
    db(req).prepare('INSERT INTO delivery_zones (name, description, sort) VALUES (?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM delivery_zones))').run(name, util.clean(req.body.description, 200));
    infra.audit(req, 'zone_created', 'zone', name); res.flash('success', 'Zone added.');
  } catch (e) { res.flash('error', 'A zone with that name already exists.'); }
  res.redirect('/admin/deliveries');
});

router.post('/zones/:id', (req, res) => {
  db(req).prepare('UPDATE delivery_zones SET name = ?, description = ?, active = ? WHERE id = ?').run(util.clean(req.body.name, 80), util.clean(req.body.description, 200), req.body.active ? 1 : 0, util.int(req.params.id));
  infra.audit(req, 'zone_updated', 'zone', req.params.id);
  res.flash('success', 'Zone saved.'); res.redirect('/admin/deliveries');
});

router.post('/zones/:id/delete', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  if (d.prepare('SELECT 1 FROM orders WHERE zone_id = ? LIMIT 1').get(id)) { d.prepare('UPDATE delivery_zones SET active = 0 WHERE id = ?').run(id); res.flash('info', 'This zone has orders, so it was switched off instead of deleted.'); }
  else { d.prepare('DELETE FROM delivery_zones WHERE id = ?').run(id); res.flash('success', 'Zone deleted.'); }
  infra.audit(req, 'zone_deleted', 'zone', id);
  res.redirect('/admin/deliveries');
});

function rateInput(b) {
  const fee = util.toPesewas(b.fee);
  const freeOver = b.free_over === '' || b.free_over === undefined ? null : util.toPesewas(b.free_over);
  const min = b.min_order ? util.toPesewas(b.min_order) : 0;
  const max = b.max_order ? util.toPesewas(b.max_order) : null;
  const method = METHODS[b.method] ? b.method : 'standard';
  return { fee, freeOver, min, max, method, name: util.clean(b.name, 80) || METHODS[method], eta: util.clean(b.eta_text, 80), courier: util.int(b.courier_id) || null, instructions: util.clean(b.instructions, 300) || null,
    ok: fee !== null && min !== null && (b.free_over === '' || b.free_over === undefined || freeOver !== null) };
}

router.post('/rates', (req, res) => {
  const d = db(req), r = rateInput(req.body), zone = util.int(req.body.zone_id);
  if (!r.ok || !d.prepare('SELECT 1 FROM delivery_zones WHERE id = ?').get(zone)) { res.flash('error', 'Check the zone and the amounts (use numbers such as 30 or 30.00).'); return res.redirect('/admin/deliveries'); }
  d.prepare('INSERT INTO delivery_rates (zone_id, method, name, fee, free_over, min_order, max_order, eta_text, courier_id, instructions) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(zone, r.method, r.name, r.method === 'pickup' ? 0 : r.fee, r.freeOver, r.min, r.max, r.eta, r.courier, r.instructions);
  infra.audit(req, 'rate_created', 'rate', null, `${r.name} @ ${r.fee}`);
  res.flash('success', 'Delivery option added.'); res.redirect('/admin/deliveries');
});

router.post('/rates/:id', (req, res) => {
  const r = rateInput(req.body);
  if (!r.ok) { res.flash('error', 'Check the amounts (use numbers such as 30 or 30.00).'); return res.redirect('/admin/deliveries'); }
  db(req).prepare('UPDATE delivery_rates SET method=?, name=?, fee=?, free_over=?, min_order=?, max_order=?, eta_text=?, courier_id=?, instructions=?, active=? WHERE id=?')
    .run(r.method, r.name, r.method === 'pickup' ? 0 : r.fee, r.freeOver, r.min, r.max, r.eta, r.courier, r.instructions, req.body.active ? 1 : 0, util.int(req.params.id));
  infra.audit(req, 'rate_updated', 'rate', req.params.id, `fee ${r.fee}`);
  res.flash('success', 'Delivery option saved.'); res.redirect('/admin/deliveries');
});

router.post('/rates/:id/delete', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  if (d.prepare('SELECT 1 FROM orders WHERE rate_id = ? LIMIT 1').get(id)) { d.prepare('UPDATE delivery_rates SET active = 0 WHERE id = ?').run(id); res.flash('info', 'This option was used on orders, so it was switched off instead of deleted.'); }
  else { d.prepare('DELETE FROM delivery_rates WHERE id = ?').run(id); res.flash('success', 'Option deleted.'); }
  infra.audit(req, 'rate_deleted', 'rate', id);
  res.redirect('/admin/deliveries');
});

router.post('/couriers', (req, res) => {
  const name = util.clean(req.body.name, 80);
  if (name.length < 2) { res.flash('error', 'Enter the courier name.'); return res.redirect('/admin/deliveries'); }
  const url = util.clean(req.body.tracking_url, 300);
  db(req).prepare('INSERT INTO couriers (name, phone, tracking_url) VALUES (?,?,?)').run(name, util.clean(req.body.phone, 40), /^https:\/\//.test(url) ? url : null);
  infra.audit(req, 'courier_created', 'courier', name);
  res.flash('success', 'Courier added.'); res.redirect('/admin/deliveries');
});

router.post('/couriers/:id', (req, res) => {
  const url = util.clean(req.body.tracking_url, 300);
  db(req).prepare('UPDATE couriers SET name = ?, phone = ?, tracking_url = ?, active = ? WHERE id = ?').run(util.clean(req.body.name, 80), util.clean(req.body.phone, 40), /^https:\/\//.test(url) ? url : null, req.body.active ? 1 : 0, util.int(req.params.id));
  res.flash('success', 'Courier saved.'); res.redirect('/admin/deliveries');
});

module.exports = router;
