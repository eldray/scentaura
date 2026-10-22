'use strict';
const express = require('express');
const config = require('../config');
const pricing = require('../services/pricing');
const orders = require('../services/orders');
const payments = require('../services/payments');
const notify = require('../services/notify');
const util = require('../lib/util');
const router = express.Router();

const db = req => req.app.locals.db;
const getCart = req => (Array.isArray(req.session.cart) ? req.session.cart : []);

function paymentOptions(req) {
  const S = req.res.locals.S;
  const opts = [];
  if (config.paystackEnabled()) opts.push({ value: 'paystack', label: 'Pay online with Paystack', hint: 'Mobile Money, card or bank transfer – the options turned on for this store at Paystack.' });
  if (S.cod_enabled === '1') opts.push({ value: 'cod', label: S.cod_label || 'Pay on delivery / pickup', hint: 'Pay when your order arrives or when you collect it.' });
  return opts;
}

function draftFrom(body) {
  return {
    name: util.clean(body.name, 120), email: util.clean(body.email, 254).toLowerCase(), phone: util.clean(body.phone, 30),
    line1: util.clean(body.line1, 200), town: util.clean(body.town, 100), region: util.clean(body.region, 60), digitalAddress: util.clean(body.digitalAddress, 20),
    notes: util.clean(body.notes, 500), rateId: util.int(body.rateId) || null, paymentMethod: util.clean(body.paymentMethod, 10),
    marketingConsent: body.marketingConsent === '1'
  };
}

function form(req, res, draft, errors) {
  const d = db(req);
  const priced = pricing.priceCart(d, getCart(req), { couponCode: req.session.couponCode, rateId: draft.rateId, email: draft.email, phone: util.normalizeGhPhone(draft.phone), customerId: req.customer && req.customer.id });
  if (!priced.lines.length) { res.flash('error', 'Your cart is empty.'); return res.redirect('/cart'); }
  const rates = pricing.availableRates(d);
  res.page('checkout', { title: 'Checkout', noindex: true, draft, errors: errors || [], priced, rates, payOptions: paymentOptions(req) });
}

router.get('/checkout', (req, res) => {
  if (!getCart(req).length) { res.flash('info', 'Your cart is empty.'); return res.redirect('/cart'); }
  const c = req.customer;
  const draft = req.session.checkoutDraft || { name: c ? c.name : '', email: c ? c.email || '' : '', phone: c ? c.phone || '' : '', region: 'Greater Accra', paymentMethod: paymentOptions(req)[0] ? paymentOptions(req)[0].value : '', marketingConsent: false };
  form(req, res, draft);
});

router.post('/checkout/review', (req, res, next) => req.app.locals.limiters.checkout(req, res, next), (req, res) => {
  const draft = draftFrom(req.body);
  const phone = util.normalizeGhPhone(draft.phone);
  const errors = [];
  if (draft.name.length < 2) errors.push('Please enter your full name.');
  if (!util.isEmail(draft.email)) errors.push('Please enter a valid email address.');
  if (!phone) errors.push('Please enter a valid Ghana phone number, for example 024 123 4567 or +233 24 123 4567.');
  const priced = pricing.priceCart(db(req), getCart(req), { couponCode: req.session.couponCode, rateId: draft.rateId, email: draft.email, phone, customerId: req.customer && req.customer.id });
  priced.errors.forEach(e => errors.push(e.message));
  if (!priced.rate) errors.push(priced.rateError || 'Please choose a delivery option.');
  else if (priced.rate.method !== 'pickup') {
    if (draft.line1.length < 4) errors.push('Please enter your delivery address.');
    if (draft.town.length < 2) errors.push('Please enter your town or area.');
    if (!util.GH_REGIONS.includes(draft.region)) errors.push('Please choose your region.');
  }
  if (!paymentOptions(req).some(o => o.value === draft.paymentMethod)) errors.push('Please choose a payment method.');
  req.session.checkoutDraft = draft;
  if (errors.length) return form(req, res, draft, errors);
  draft.phone = phone;
  res.page('review', { title: 'Review your order', noindex: true, draft, priced, payOptions: paymentOptions(req) });
});

router.post('/checkout/confirm', (req, res, next) => req.app.locals.limiters.checkout(req, res, next), async (req, res) => {
  const draft = req.session.checkoutDraft;
  if (!draft) return res.redirect('/checkout');
  let order;
  try {
    order = orders.createOrder(db(req), { ...draft, items: getCart(req), couponCode: req.session.couponCode, customerId: req.customer ? req.customer.id : null });
  } catch (e) {
    if (e instanceof orders.OrderError) return form(req, res, draft, e.messages);
    throw e;
  }
  req.session.cart = []; req.session.couponCode = null; req.session.checkoutDraft = null;

  // Remember consent / create nothing else for guests. For signed-in customers keep contact details up to date.
  if (req.customer && draft.marketingConsent && !req.customer.marketing_consent) {
    db(req).prepare("UPDATE customers SET marketing_consent = 1, marketing_consent_at = datetime('now') WHERE id = ?").run(req.customer.id);
  }
  notify.orderPlaced(db(req), order);

  if (order.payment_method === 'paystack') {
    try {
      const { url } = await payments.initialize(db(req), order, `${config.baseUrl}/payment/callback`);
      return res.redirect(303, url);
    } catch (e) {
      console.error('Paystack initialise failed:', e.message);
      res.flash('error', 'We could not open the payment page just now. Your order is saved – please press “Pay now” to try again.');
    }
  }
  res.redirect(`/order/${order.order_no}?t=${order.tracking_token}`);
});

/* Customer comes back from Paystack. We ask Paystack what really happened. */
router.get('/payment/callback', async (req, res) => {
  const reference = util.clean(req.query.reference || req.query.trxref, 80);
  const row = reference ? db(req).prepare('SELECT o.order_no, o.tracking_token FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.reference = ?').get(reference) : null;
  if (!row) return res.redirect('/track');
  const r = await payments.verifyReference(db(req), reference);
  if (r.status === 'success') res.flash('success', 'Payment received. Thank you!');
  else if (r.status === 'pending') res.flash('info', 'Your payment is still being processed. This page will show “Paid” once it is confirmed – you can refresh in a minute.');
  else if (r.status === 'error') res.flash('info', 'We could not confirm your payment yet. If money left your account, do not worry – we will update your order automatically.');
  else res.flash('error', 'Your payment was not completed. You can try again below.');
  res.redirect(`/order/${row.order_no}?t=${row.tracking_token}`);
});

function loadOrderForCustomer(req) {
  const o = orders.getOrderByNo(db(req), util.clean(req.params.orderNo, 40));
  if (!o) return null;
  const token = util.clean(req.query.t || (req.body && req.body.t), 64);
  const owner = req.customer && o.customer_id === req.customer.id;
  if (owner || (token && util.safeEqual(token, o.tracking_token))) return o;
  return null;
}

router.get('/order/:orderNo', (req, res) => {
  const o = loadOrderForCustomer(req);
  if (!o) return res.status(404).page('error', { title: 'Order not found', message: 'We could not find that order. Use the Track order page with your order number and phone number.', noindex: true });
  const d = db(req);
  const courier = o.courier_id ? d.prepare('SELECT * FROM couriers WHERE id = ?').get(o.courier_id) : null;
  const rate = o.rate_id ? d.prepare('SELECT instructions FROM delivery_rates WHERE id = ?').get(o.rate_id) : null;
  res.page('order', {
    title: `Order ${o.order_no}`, noindex: true, o, items: orders.getItems(d, o.id), courier, rateInstructions: rate && rate.instructions,
    events: d.prepare("SELECT * FROM order_events WHERE order_id = ? AND kind IN ('status','delivery_attempt') ORDER BY id").all(o.id),
    trackUrl: courier && courier.tracking_url && o.tracking_no ? courier.tracking_url.replace('{tracking}', encodeURIComponent(o.tracking_no)) : null,
    canPay: o.payment_method === 'paystack' && ['unpaid', 'pending', 'failed', 'cancelled'].includes(o.payment_status) && config.paystackEnabled() &&
      (o.status === 'payment_pending' || (o.status === 'cancelled' && d.prepare("SELECT 1 FROM order_events WHERE order_id = ? AND note LIKE '%not completed in time%'").get(o.id))),
    waUrl: res.locals.waLink(`Hello, I have a question about my order ${o.order_no}.`)
  });
});

router.post('/order/:orderNo/pay', (req, res, next) => req.app.locals.limiters.checkout(req, res, next), async (req, res) => {
  const o = loadOrderForCustomer(req);
  if (!o) return res.redirect('/track');
  const back = `/order/${o.order_no}?t=${o.tracking_token}`;
  // Check first whether an earlier attempt actually succeeded.
  const pend = db(req).prepare("SELECT reference FROM payments WHERE order_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(o.id);
  if (pend) {
    const r = await payments.verifyReference(db(req), pend.reference);
    if (r.status === 'success') { res.flash('success', 'Your payment has been confirmed. Thank you!'); return res.redirect(back); }
  }
  let fresh = orders.getOrder(db(req), o.id);
  if (fresh.status === 'cancelled') {
    // The reservation expired. Try to take the stock again so the customer can still buy.
    try {
      const inv = require('../services/inventory');
      db(req).transaction(() => {
        inv.reserveForOrder(db(req), fresh.id);
        db(req).prepare("UPDATE orders SET status = 'payment_pending' WHERE id = ?").run(fresh.id);
        orders.addEvent(db(req), fresh.id, { status: 'payment_pending', note: 'Customer retried payment; stock reserved again' });
      })();
      fresh = orders.getOrder(db(req), o.id);
    } catch (e) { res.flash('error', 'Sorry, this order expired and the item is no longer available.'); return res.redirect(back); }
  }
  try {
    const { url } = await payments.initialize(db(req), fresh, `${config.baseUrl}/payment/callback`);
    res.redirect(303, url);
  } catch (e) {
    console.error('Paystack initialise failed:', e.message);
    res.flash('error', 'We could not open the payment page. Please try again in a moment.');
    res.redirect(back);
  }
});

router.get('/track', (req, res) => res.page('track', { title: 'Track your order', description: 'Check the status of your order.', canonical: `${res.locals.baseUrl}/track`, error: null }));

router.post('/track', (req, res, next) => req.app.locals.limiters.track(req, res, next), (req, res) => {
  const no = util.clean(req.body.orderNo, 40).toUpperCase();
  const who = util.clean(req.body.contact, 254);
  const o = orders.getOrderByNo(db(req), no);
  const phone = util.normalizeGhPhone(who);
  const ok = o && ((phone && phone === o.customer_phone) || (who && o.customer_email.toLowerCase() === who.toLowerCase()));
  if (!ok) return res.status(404).page('track', { title: 'Track your order', error: 'We could not find an order matching those details. Check the order number and the phone number or email you used.' });
  res.redirect(`/order/${o.order_no}?t=${o.tracking_token}`);
});

module.exports = router;
