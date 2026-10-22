'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const util = require('../src/lib/util');
const pricing = require('../src/services/pricing');

test('money helpers use whole pesewas', () => {
  assert.equal(util.toPesewas('1,450.50'), 145050);
  assert.equal(util.toPesewas('450'), 45000);
  assert.equal(util.toPesewas('12.345'), null);
  assert.equal(util.toPesewas('-5'), null);
  assert.equal(util.ghs(145050), 'GHS 1,450.50');
});

test('Ghana phone numbers are normalised, junk is rejected', () => {
  for (const n of ['024 123 4567', '0241234567', '233241234567', '+233 24 123 4567', '+233-24-123-4567']) assert.equal(util.normalizeGhPhone(n), '+233241234567', n);
  assert.equal(util.normalizeGhPhone('0201234567'), '+233201234567');
  for (const n of ['12345', '0141234567', '+1 202 555 0100', '', null, 'abc']) assert.equal(util.normalizeGhPhone(n), null, String(n));
});

test('totals are computed on the server from database prices, including sale price and delivery', () => {
  const db = h.freshDb();
  const [a, b] = h.addProduct(db, 'Noir', [['50 ml', 38000, 15000, 10], ['100 ml', 62000, 26000, 10, 55000]]);
  const rate = h.addRate(db, { fee: 3000 });
  const p = pricing.priceCart(db, [{ variantId: a, qty: 2 }, { variantId: b, qty: 1 }], { rateId: rate });
  assert.equal(p.subtotal, 38000 * 2 + 55000);
  assert.equal(p.deliveryFee, 3000);
  assert.equal(p.total, 76000 + 55000 + 3000);
});

test('browser-supplied prices are ignored', () => {
  const db = h.freshDb();
  const [a] = h.addProduct(db, 'Noir', [['50 ml', 38000, 15000, 10]]);
  const p = pricing.priceCart(db, [{ variantId: a, qty: 1, price: 1, unitPrice: 1, total: 1 }], {});
  assert.equal(p.subtotal, 38000);
});

test('free delivery over a threshold, and zone minimums', () => {
  const db = h.freshDb();
  const [a] = h.addProduct(db, 'Noir', [['50 ml', 38000, 15000, 10]]);
  const free = h.addRate(db, { fee: 3000, freeOver: 70000 });
  assert.equal(pricing.priceCart(db, [{ variantId: a, qty: 1 }], { rateId: free }).deliveryFee, 3000);
  assert.equal(pricing.priceCart(db, [{ variantId: a, qty: 2 }], { rateId: free }).deliveryFee, 0);
  const min = h.addRate(db, { fee: 100, min: 100000 });
  const p = pricing.priceCart(db, [{ variantId: a, qty: 1 }], { rateId: min });
  assert.equal(p.rate, null);
  assert.ok(p.rateError);
});

test('quantities are clamped to stock; unavailable and inactive items are dropped', () => {
  const db = h.freshDb();
  const [a] = h.addProduct(db, 'Noir', [['50 ml', 38000, 15000, 3]]);
  const [gone] = h.addProduct(db, 'Draft', [['50 ml', 1000, 500, 5]], { status: 'draft' });
  const [none] = h.addProduct(db, 'Empty', [['50 ml', 1000, 500, 0]]);
  const p = pricing.priceCart(db, [{ variantId: a, qty: 9 }, { variantId: gone, qty: 1 }, { variantId: none, qty: 1 }], {});
  assert.equal(p.lines.length, 1);
  assert.equal(p.lines[0].qty, 3);
  assert.equal(p.errors.length, 3);
});

test('coupons: percentage, fixed, minimum spend, expiry, usage cap, first order, once per customer', () => {
  const db = h.freshDb();
  const [a] = h.addProduct(db, 'Noir', [['50 ml', 40000, 15000, 50]]);
  const rate = h.addRate(db);
  const ins = (code, type, value, extra = {}) => db.prepare('INSERT INTO coupons (code, type, value, min_spend, max_uses, first_order_only, once_per_customer, expires_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(code, type, value, extra.min || 0, extra.max || null, extra.first ? 1 : 0, extra.once === false ? 0 : 1, extra.expires || null);
  ins('TEN', 'percent', 10); ins('FIVE', 'fixed', 5000); ins('BIG', 'percent', 10, { min: 100000 }); ins('OLD', 'percent', 10, { expires: '2020-01-01 00:00:00' }); ins('ONCE', 'percent', 10, { max: 1 }); ins('FIRST', 'percent', 10, { first: true });
  const price = code => pricing.priceCart(db, [{ variantId: a, qty: 1 }], { couponCode: code, rateId: rate, email: 'ama@example.com', phone: '+233241234567' });
  assert.equal(price('ten').discount, 4000);
  assert.equal(price('FIVE').discount, 5000);
  assert.equal(price('BIG').discount, 0); assert.ok(price('BIG').couponError);
  assert.ok(price('OLD').couponError);
  assert.ok(price('NOPE').couponError);
  // usage cap
  h.order(db, [[a, 1]], { rateId: rate, couponCode: 'ONCE' });
  assert.match(price('ONCE').couponError, /fully used/);
  // once per customer
  h.order(db, [[a, 1]], { rateId: rate, couponCode: 'TEN' });
  assert.match(price('TEN').couponError, /already used/);
  // first order only
  assert.match(price('FIRST').couponError, /first orders/);
});

test('discount can never exceed the subtotal', () => {
  const db = h.freshDb();
  const [a] = h.addProduct(db, 'Cheap', [['10 ml', 2000, 500, 5]]);
  db.prepare("INSERT INTO coupons (code, type, value) VALUES ('HUGE','fixed',999999)").run();
  const p = pricing.priceCart(db, [{ variantId: a, qty: 1 }], { couponCode: 'HUGE' });
  assert.equal(p.discount, 2000);
  assert.equal(p.total, 0);
});
