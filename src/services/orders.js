'use strict';
const inventory = require('./inventory');
const pricing = require('./pricing');
const util = require('../lib/util');
const settings = require('../lib/settings');

class OrderError extends Error {
  constructor(messages) {
    super(Array.isArray(messages) ? messages.join(' ') : messages);
    this.name = 'OrderError';
    this.messages = Array.isArray(messages) ? messages : [messages];
  }
}

/** Which fulfilment statuses may follow which. */
const NEXT = {
  pending_confirmation: ['processing', 'packed', 'dispatched', 'cancelled'],
  payment_pending: ['cancelled'],
  paid: ['processing', 'packed', 'dispatched', 'cancelled'],
  processing: ['packed', 'dispatched', 'cancelled'],
  packed: ['dispatched', 'cancelled'],
  dispatched: ['out_for_delivery', 'delivered', 'returned', 'return_requested', 'cancelled'],
  out_for_delivery: ['delivered', 'dispatched', 'returned', 'cancelled'],
  delivered: ['return_requested'],
  return_requested: ['returned', 'delivered'],
  returned: [],
  cancelled: [],
  refunded: []
};

function addEvent(db, orderId, { kind = 'status', status = null, note = null, userId = null }) {
  db.prepare('INSERT INTO order_events (order_id, kind, status, note, user_id) VALUES (?,?,?,?,?)').run(orderId, kind, status, note, userId);
}

function getOrder(db, id) { return db.prepare('SELECT * FROM orders WHERE id = ?').get(id); }
function getOrderByNo(db, no) { return db.prepare('SELECT * FROM orders WHERE order_no = ?').get(no); }
function getItems(db, orderId) { return db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId); }

/**
 * Validate everything again on the server, then in ONE transaction:
 * create the order, snapshot the items, reserve the stock, and count the coupon.
 */
function createOrder(db, input) {
  const errs = [];
  const name = util.clean(input.name, 120);
  const email = util.clean(input.email, 254).toLowerCase();
  const phone = util.normalizeGhPhone(input.phone);
  if (name.length < 2) errs.push('Please enter your full name.');
  if (!util.isEmail(email)) errs.push('Please enter a valid email address.');
  if (!phone) errs.push('Please enter a valid Ghana phone number, for example 024 123 4567 or +233 24 123 4567.');
  if (!['momo', 'paystack', 'cod'].includes(input.paymentMethod)) errs.push('Please choose a payment method.');
  if (input.paymentMethod === 'cod' && settings.get('cod_enabled', '0', db) !== '1') errs.push('Pay on delivery is not available.');

  const priced = pricing.priceCart(db, input.items, { rateId: input.rateId, couponCode: input.couponCode, email, phone, customerId: input.customerId });
  if (!priced.lines.length) errs.push('Your cart is empty.');
  priced.errors.forEach(e => errs.push(e.message));
  if (!priced.rate) errs.push(priced.rateError || 'Please choose a delivery option.');
  if (priced.couponError && input.couponCode) errs.push(priced.couponError);

  const isPickup = priced.rate && priced.rate.method === 'pickup';
  const line1 = util.clean(input.line1, 200), town = util.clean(input.town, 100), region = util.clean(input.region, 60);
  if (priced.rate && !isPickup) {
    if (line1.length < 4) errs.push('Please enter your delivery address.');
    if (town.length < 2) errs.push('Please enter your town or area.');
    if (!util.GH_REGIONS.includes(region)) errs.push('Please choose your region.');
  }
  if (errs.length) throw new OrderError([...new Set(errs)]);

  return db.transaction(() => {
    let orderNo, tries = 0;
    do { orderNo = util.orderNumber(); tries++; } while (getOrderByNo(db, orderNo) && tries < 5);

    const online = input.paymentMethod !== 'cod';
    const info = db.prepare(`INSERT INTO orders
      (order_no, tracking_token, customer_id, customer_name, customer_email, customer_phone,
       ship_line1, ship_town, ship_region, ship_digital_address, delivery_notes,
       zone_id, zone_name, rate_id, delivery_method, delivery_name,
       subtotal, discount, delivery_fee, total, coupon_id, coupon_code, referrer_customer_id,
       payment_method, payment_status, status, marketing_consent)
      VALUES (?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?)`).run(
      orderNo, util.token(16), input.customerId || null, name, email, phone,
      isPickup ? '' : line1, isPickup ? '' : town, isPickup ? '' : region, util.clean(input.digitalAddress, 20) || null, util.clean(input.notes, 500) || null,
      priced.rate.zone_id, priced.rate.zone_name, priced.rate.id, priced.rate.method, priced.rate.name,
      priced.subtotal, priced.discount, priced.deliveryFee, priced.total, priced.coupon ? priced.coupon.id : null, priced.coupon ? priced.coupon.code : null, priced.referrerId,
      input.paymentMethod, online ? 'unpaid' : 'unpaid', online ? 'payment_pending' : 'pending_confirmation', input.marketingConsent ? 1 : 0);
    const orderId = Number(info.lastInsertRowid);

    const insItem = db.prepare(`INSERT INTO order_items
      (order_id, variant_id, product_id, product_name, brand_name, category_name, size_label, sku, list_price, unit_price, unit_cost, qty, line_total)
      VALUES (?,?,?,?,?,?,?,?,?,?,(SELECT cost FROM product_variants WHERE id = ?),?,?)`);
    for (const l of priced.lines) {
      insItem.run(orderId, l.variantId, l.productId, l.name, l.brand, l.category, l.size, l.sku, l.listPrice, l.unitPrice, l.variantId, l.qty, l.lineTotal);
    }

    try {
      inventory.reserveForOrder(db, orderId);
    } catch (e) {
      if (e instanceof inventory.StockError) throw new OrderError('Sorry, one of the items just sold out. Please review your cart.');
      throw e;
    }

    if (priced.coupon && priced.coupon.id) {
      db.prepare('INSERT INTO coupon_redemptions (coupon_id, order_id, email, phone) VALUES (?,?,?,?)').run(priced.coupon.id, orderId, email, phone);
      db.prepare('UPDATE coupons SET uses = uses + 1 WHERE id = ?').run(priced.coupon.id);
    }
    addEvent(db, orderId, { status: online ? 'payment_pending' : 'pending_confirmation', note: 'Order placed' });
    return getOrder(db, orderId);
  })();
}

function releaseCoupon(db, order) {
  if (!order.coupon_id) return;
  const r = db.prepare('DELETE FROM coupon_redemptions WHERE coupon_id = ? AND order_id = ?').run(order.coupon_id, order.id);
  if (r.changes) db.prepare('UPDATE coupons SET uses = MAX(uses - 1, 0) WHERE id = ?').run(order.coupon_id);
}

/**
 * Move an order to a new fulfilment status, applying the stock rules.
 * opts: { userId, note, restock (for returns) }
 */
function setStatus(db, orderId, to, opts = {}) {
  return db.transaction(() => {
    const o = getOrder(db, orderId);
    if (!o) throw new OrderError('Order not found.');
    if (o.status === to) return o;
    if (!(NEXT[o.status] || []).includes(to)) throw new OrderError(`An order that is "${util.ORDER_STATUSES[o.status]}" cannot be changed to "${util.ORDER_STATUSES[to]}".`);

    const gate = ['processing', 'packed', 'dispatched', 'out_for_delivery', 'delivered'];
    if (o.payment_method !== 'cod' && o.payment_status !== 'paid' && gate.includes(to)) {
      throw new OrderError('This order has not been paid yet, so it cannot be processed or shipped.');
    }

    if (to === 'dispatched' || to === 'out_for_delivery' || to === 'delivered') {
      if (o.stock_state === 'reserved') inventory.commitOrder(db, o.id);   // pay-on-delivery stock leaves the shelf here
    }
    if (to === 'processing' && o.payment_method === 'cod' && o.stock_state === 'released') {
      inventory.reserveForOrder(db, o.id);
    }
    if (to === 'cancelled') {
      if (o.stock_state === 'reserved') inventory.releaseOrder(db, o.id);
      else if (o.stock_state === 'deducted') inventory.restoreOrder(db, o.id, { type: 'cancel_restore', reason: 'Order cancelled', userId: opts.userId });
      releaseCoupon(db, o);
      db.prepare("UPDATE payments SET status = 'abandoned' WHERE order_id = ? AND status = 'pending'").run(o.id);
      if (o.payment_status === 'paid') db.prepare("UPDATE orders SET needs_attention = 'Cancelled after payment – refund the customer.' WHERE id = ?").run(o.id);
    }
    if (to === 'returned') {
      if (opts.restock) inventory.restoreOrder(db, o.id, { type: 'return', reason: 'Returned and resaleable', userId: opts.userId });
      else addEvent(db, o.id, { kind: 'stock', note: 'Returned item was NOT put back into stock.', userId: opts.userId });
    }

    const sets = ["status = ?", "updated_at = datetime('now')"];
    const args = [to];
    if (to === 'dispatched' && !o.dispatched_at) sets.push("dispatched_at = datetime('now')");
    if (to === 'delivered') sets.push("delivered_at = datetime('now')");
    args.push(o.id);
    db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    addEvent(db, o.id, { status: to, note: opts.note || null, userId: opts.userId });
    return getOrder(db, o.id);
  })();
}

/** Cancel unpaid online orders that were never completed and free their stock. */
function expireStaleOrders(db, now = new Date()) {
  const minutes = parseInt(settings.get('reservation_minutes', '120', db), 10) || 120;
  const cutoff = new Date(now.getTime() - minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
  const stale = db.prepare(`SELECT id FROM orders WHERE payment_method != 'cod' AND status = 'payment_pending'
    AND payment_status IN ('unpaid','pending','failed','cancelled') AND created_at < ?`).all(cutoff);
  let n = 0;
  for (const s of stale) {
    try { setStatus(db, s.id, 'cancelled', { note: 'Payment was not completed in time. Stock released.' }); n++; } catch (e) { /* skip */ }
  }
  return n;
}

function statusLabel(s) { return util.ORDER_STATUSES[s] || s; }

module.exports = { OrderError, NEXT, createOrder, setStatus, expireStaleOrders, addEvent, getOrder, getOrderByNo, getItems, releaseCoupon, statusLabel };
