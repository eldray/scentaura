'use strict';
const express = require('express');
const infra = require('../../lib/infra');
const util = require('../../lib/util');
const router = express.Router();
const db = req => req.app.locals.db;

router.get('/', (req, res) => {
  const d = db(req);
  const q = util.clean(req.query.q, 80);
  const rows = d.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS orders,
      (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.customer_id = c.id AND o.payment_status IN ('paid','partially_refunded') AND o.status != 'cancelled') AS spent
    FROM customers c WHERE (? = '' OR c.name LIKE '%' || ? || '%' OR c.email LIKE '%' || ? || '%' OR c.phone LIKE '%' || ? || '%') ORDER BY c.id DESC LIMIT 300`).all(q, q, q, q);
  const guests = d.prepare(`SELECT customer_name, customer_email, customer_phone, COUNT(*) AS orders, SUM(total) AS spent, MAX(created_at) AS last_order, MAX(marketing_consent) AS consent
    FROM orders WHERE customer_id IS NULL AND (? = '' OR customer_name LIKE '%' || ? || '%' OR customer_email LIKE '%' || ? || '%' OR customer_phone LIKE '%' || ? || '%')
    GROUP BY lower(customer_email) ORDER BY MAX(id) DESC LIMIT 200`).all(q, q, q, q);
  res.admin('customers', { pageTitle: 'Customers', rows, guests, q });
});

/** Only people who ticked the consent box. Never export anyone else for marketing. */
router.get('/marketing-list.csv', (req, res) => {
  const d = db(req);
  const reg = d.prepare('SELECT name, email, phone, marketing_consent_at FROM customers WHERE marketing_consent = 1').all();
  const guests = d.prepare(`SELECT customer_name AS name, customer_email AS email, customer_phone AS phone, MAX(created_at) AS marketing_consent_at FROM orders WHERE marketing_consent = 1 AND customer_id IS NULL GROUP BY lower(customer_email)`).all();
  infra.audit(req, 'marketing_list_exported', 'customers', null, `${reg.length + guests.length} people`);
  infra.sendCsv(res, 'marketing-consented-customers.csv', ['Name', 'Email', 'Phone', 'Consent date (UTC)'], [...reg, ...guests].map(c => [c.name, c.email, c.phone, c.marketing_consent_at]));
});

router.get('/:id', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  const c = d.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!c) return res.redirect('/admin/customers');
  res.admin('customer', {
    pageTitle: c.name, c, orders: d.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC').all(id),
    referred: d.prepare('SELECT name, created_at FROM customers WHERE referred_by = ?').all(id),
    referrer: c.referred_by ? d.prepare('SELECT id, name FROM customers WHERE id = ?').get(c.referred_by) : null
  });
});

module.exports = router;
