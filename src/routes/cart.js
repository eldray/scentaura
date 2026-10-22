'use strict';
const express = require('express');
const pricing = require('../services/pricing');
const util = require('../lib/util');
const router = express.Router();

const db = req => req.app.locals.db;
const getCart = req => (Array.isArray(req.session.cart) ? req.session.cart : []);
function safeBack(b, fallback) { return typeof b === 'string' && b.startsWith('/') && !b.startsWith('//') ? b : fallback; }

router.get('/cart', (req, res) => {
  const priced = pricing.priceCart(db(req), getCart(req), {
    couponCode: req.session.couponCode, customerId: req.customer && req.customer.id, email: req.customer && req.customer.email
  });
  // Keep the saved cart in line with what is really available.
  req.session.cart = priced.lines.map(l => ({ variantId: l.variantId, qty: l.qty }));
  if (req.session.couponCode && !priced.coupon) { req.session.couponCode = null; }
  res.page('cart', { title: 'Your cart', priced, noindex: true });
});

router.post('/cart/add', (req, res) => {
  const variantId = util.int(req.body.variantId), qty = Math.max(1, util.int(req.body.qty, 1));
  const v = db(req).prepare(`SELECT v.id, v.on_hand, v.reserved, v.active, p.status, p.slug FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`).get(variantId);
  const back = safeBack(req.body.back, '/cart');
  if (!v || !v.active || v.status !== 'active') { res.flash('error', 'That product is not available.'); return res.redirect(back); }
  const cart = getCart(req).filter(i => i.variantId !== variantId);
  const existing = getCart(req).find(i => i.variantId === variantId);
  const wanted = Math.min((existing ? existing.qty : 0) + qty, pricing.MAX_QTY_PER_LINE);
  const avail = Math.max(0, v.on_hand - v.reserved);
  if (avail <= 0) { res.flash('error', 'Sorry, that size is out of stock.'); return res.redirect(back); }
  const finalQty = Math.min(wanted, avail);
  cart.push({ variantId, qty: finalQty });
  req.session.cart = cart;
  if (finalQty < wanted) res.flash('info', `We only have ${avail} in stock, so we added ${finalQty}.`);
  else res.flash('success', 'Added to your cart.');
  res.redirect(req.body.buyNow ? '/checkout' : back === '/cart' ? '/cart' : back);
});

router.post('/cart/update', (req, res) => {
  const variantId = util.int(req.body.variantId), qty = util.int(req.body.qty);
  req.session.cart = getCart(req).map(i => i.variantId === variantId ? { variantId, qty } : i).filter(i => i.qty > 0);
  res.redirect('/cart');
});

router.post('/cart/remove', (req, res) => {
  const variantId = util.int(req.body.variantId);
  req.session.cart = getCart(req).filter(i => i.variantId !== variantId);
  res.redirect('/cart');
});

router.post('/cart/coupon', (req, res, next) => req.app.locals.limiters.coupon(req, res, next), (req, res) => {
  const code = util.clean(req.body.code, 40);
  if (!code) { req.session.couponCode = null; return res.redirect(safeBack(req.body.back, '/cart')); }
  const priced = pricing.priceCart(db(req), getCart(req), { couponCode: code, customerId: req.customer && req.customer.id, email: req.customer && req.customer.email });
  if (priced.coupon) { req.session.couponCode = code; res.flash('success', `Code ${priced.coupon.code} applied.`); }
  else { req.session.couponCode = null; res.flash('error', priced.couponError || 'That code is not valid.'); }
  res.redirect(safeBack(req.body.back, '/cart'));
});

module.exports = router;
