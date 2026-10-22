'use strict';
const express = require('express');
const util = require('../../lib/util');
const infra = require('../../lib/infra');
const router = express.Router();
const db = req => req.app.locals.db;

function dateOrNull(s, end) { return /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? `${s} ${end ? '23:59:59' : '00:00:00'}` : null; }

router.get('/', (req, res) => {
  const d = db(req);
  res.admin('promotions', { pageTitle: 'Promotions & coupons', coupons: d.prepare('SELECT * FROM coupons ORDER BY id DESC').all(),
    referralPct: res.locals.S.referral_discount_percent,
    referrals: d.prepare(`SELECT c.name, c.referral_code, (SELECT COUNT(*) FROM customers x WHERE x.referred_by = c.id) AS signups,
      (SELECT COUNT(*) FROM orders o WHERE o.referrer_customer_id = c.id AND o.payment_status = 'paid') AS paid_orders FROM customers c
      WHERE EXISTS (SELECT 1 FROM customers x WHERE x.referred_by = c.id) OR EXISTS (SELECT 1 FROM orders o WHERE o.referrer_customer_id = c.id) ORDER BY signups DESC LIMIT 20`).all() });
});

router.post('/', (req, res) => {
  const d = db(req);
  const code = util.clean(req.body.code, 30).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const type = req.body.type === 'fixed' ? 'fixed' : 'percent';
  let value = type === 'percent' ? util.int(req.body.value) : util.toPesewas(req.body.value);
  const min = req.body.min_spend ? util.toPesewas(req.body.min_spend) : 0;
  if (code.length < 3 || !value || value <= 0 || (type === 'percent' && value > 100) || min === null) {
    res.flash('error', 'Enter a code (3+ letters/numbers), a discount value (percent 1–100, or a cedi amount) and a valid minimum spend.');
    return res.redirect('/admin/promotions');
  }
  try {
    d.prepare(`INSERT INTO coupons (code, description, type, value, min_spend, max_uses, once_per_customer, first_order_only, starts_at, expires_at, active)
      VALUES (?,?,?,?,?,?,?,?,?,?,1)`).run(code, util.clean(req.body.description, 200), type, value, min, req.body.max_uses ? Math.max(1, util.int(req.body.max_uses)) : null,
      req.body.once_per_customer ? 1 : 0, req.body.first_order_only ? 1 : 0, dateOrNull(req.body.starts_at, false), dateOrNull(req.body.expires_at, true));
    infra.audit(req, 'coupon_created', 'coupon', code);
    res.flash('success', `Code ${code} created.`);
  } catch (e) { res.flash('error', /UNIQUE/.test(e.message) ? 'That code already exists.' : 'Could not save the code.'); }
  res.redirect('/admin/promotions');
});

router.post('/:id/toggle', (req, res) => {
  db(req).prepare('UPDATE coupons SET active = 1 - active WHERE id = ?').run(util.int(req.params.id));
  infra.audit(req, 'coupon_toggled', 'coupon', req.params.id);
  res.redirect('/admin/promotions');
});

router.post('/:id/delete', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  if (d.prepare('SELECT 1 FROM orders WHERE coupon_id = ? LIMIT 1').get(id)) {
    d.prepare('UPDATE coupons SET active = 0 WHERE id = ?').run(id);
    res.flash('info', 'This code has been used on orders, so it was switched off instead of deleted.');
  } else { d.prepare('DELETE FROM coupons WHERE id = ?').run(id); res.flash('success', 'Code deleted.'); }
  infra.audit(req, 'coupon_deleted', 'coupon', id);
  res.redirect('/admin/promotions');
});

module.exports = router;
