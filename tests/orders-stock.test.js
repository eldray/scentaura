'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test('creating an order snapshots the items and reserves stock', () => {
  const db = h.freshDb();
  const [a] = h.addProduct(db, 'Noir', [['50 ml', 38000, 15000, 10]]);
  const rate = h.addRate(db);
  const o = h.order(db, [[a, 2]], { rateId: rate });
  assert.equal(o.status, 'payment_pending');
  assert.equal(o.total, 38000 * 2 + 3000);
  assert.match(o.order_no, /^SA-\d{6}-[A-Z0-9]{5}$/);
  assert.deepEqual(h.stock(db, a), { on_hand: 10, reserved: 2 });
  // renaming the product or changing the price later does not change history
  db.prepare("UPDATE products SET name = 'Renamed'").run();
  db.prepare('UPDATE product_variants SET price = 1').run();
  const item = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(o.id);
  assert.equal(item.product_name, 'Noir'); assert.equal(item.unit_price, 38000);
});

test('two customers cannot buy the same last unit', () => {
  const db = h.freshDb();
  const [a] = h.addProduct(db, 'Last One', [['50 ml', 10000, 5000, 1]]);
  const rate = h.addRate(db);
  h.order(db, [[a, 1]], { rateId: rate });
  assert.throws(() => h.order(db, [[a, 1]], { rateId: rate, phone: '0551112222' }), /Cart is empty|out of stock|sold out/i);
  assert.deepEqual(h.stock(db, a), { on_hand: 1, reserved: 1 });
});

test('stock can never go negative at the database level', () => {
  const db = h.freshDb();
  const [a] = h.addProduct(db, 'X', [['50 ml', 10000, 5000, 2]]);
  assert.throws(() => h.inventory.move(db, a, { type: 'adjustment', onHandChange: -3, reason: 'x' }), /Not enough stock/);
  assert.throws(() => h.inventory.move(db, a, { type: 'reserve', reservedChange: 3 }), /Not enough stock/);
  assert.deepEqual(h.stock(db, a), { on_hand: 2, reserved: 0 });
});

test('a failed order creation leaves no partial data', () => {
  const db = h.freshDb();
  const [a, b] = [...h.addProduct(db, 'A', [['50 ml', 10000, 5000, 5]]), ...h.addProduct(db, 'B', [['50 ml', 10000, 5000, 5]])];
  const rate = h.addRate(db);
  // validation failure
  assert.throws(() => h.order(db, [[a, 1]], { rateId: rate, phone: 'bad' }), /phone/i);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM orders').get().c, 0);
  assert.deepEqual(h.stock(db, a), { on_hand: 5, reserved: 0 });
  assert.deepEqual(h.stock(db, b), { on_hand: 5, reserved: 0 });
});

test('validation: required fields, region, delivery option, COD switched off', () => {
  const db = h.freshDb();
  const [a] = h.addProduct(db, 'A', [['50 ml', 10000, 5000, 5]]);
  const rate = h.addRate(db);
  assert.throws(() => h.order(db, [[a, 1]], { rateId: rate, extra: { email: 'nope' } }), /email/i);
  assert.throws(() => h.order(db, [[a, 1]], { rateId: rate, extra: { region: 'Mars' } }), /region/i);
  assert.throws(() => h.order(db, [[a, 1]], {}), /delivery option/i);
  assert.throws(() => h.order(db, [[a, 1]], { rateId: rate, paymentMethod: 'cod' }), /not available/i);
  assert.throws(() => h.order(db, [], { rateId: rate }), /empty/i);
});

test('pickup orders do not need an address', () => {
  const db = h.freshDb();
  const [a] = h.addProduct(db, 'A', [['50 ml', 10000, 5000, 5]]);
  const rate = h.addRate(db, { method: 'pickup', fee: 0, name: 'Pickup' });
  const o = h.order(db, [[a, 1]], { rateId: rate, extra: { line1: '', town: '', region: '' } });
  assert.equal(o.delivery_fee, 0); assert.equal(o.ship_line1, '');
});

test('cancelling an unpaid order releases its stock and its coupon use', () => {
  const db = h.freshDb();
  const [a] = h.addProduct(db, 'A', [['50 ml', 10000, 5000, 5]]);
  const rate = h.addRate(db);
  db.prepare("INSERT INTO coupons (code, type, value) VALUES ('TEN','percent',10)").run();
  const o = h.order(db, [[a, 2]], { rateId: rate, couponCode: 'TEN' });
  assert.equal(db.prepare("SELECT uses FROM coupons WHERE code = 'TEN'").get().uses, 1);
  h.orders.setStatus(db, o.id, 'cancelled', {});
  assert.deepEqual(h.stock(db, a), { on_hand: 5, reserved: 0 });
  assert.equal(db.prepare("SELECT uses FROM coupons WHERE code = 'TEN'").get().uses, 0);
});

test('unpaid online orders expire and free their stock', () => {
  const db = h.freshDb();
  const [a] = h.addProduct(db, 'A', [['50 ml', 10000, 5000, 5]]);
  const rate = h.addRate(db);
  const o = h.order(db, [[a, 3]], { rateId: rate });
  db.prepare("UPDATE orders SET created_at = datetime('now','-3 hours') WHERE id = ?").run(o.id);
  assert.equal(h.orders.expireStaleOrders(db), 1);
  assert.deepEqual(h.stock(db, a), { on_hand: 5, reserved: 0 });
  assert.equal(h.orders.getOrder(db, o.id).status, 'cancelled');
});

test('manual stock changes need a reason and a user; every change is logged', () => {
  const db = h.freshDb();
  const [a] = h.addProduct(db, 'A', [['50 ml', 10000, 5000, 5]]);
  db.prepare("INSERT INTO users (id,email,name,password_hash,role) VALUES (1,'o@x.com','Owner','x','owner')").run();
  assert.throws(() => h.inventory.adjustStock(db, a, -1, '', 1), /reason/i);
  assert.throws(() => h.inventory.adjustStock(db, a, -1, 'broken', null), /user/i);
  h.inventory.adjustStock(db, a, -1, 'Bottle broke', 1, 'damage');
  const m = db.prepare("SELECT * FROM stock_movements WHERE type = 'damage'").get();
  assert.equal(m.on_hand_change, -1); assert.equal(m.user_id, 1); assert.equal(m.reason, 'Bottle broke');
  h.inventory.stockCount(db, a, 6, 'found one', 1);
  assert.equal(h.stock(db, a).on_hand, 6);
});

test('receiving stock updates the weighted-average cost', () => {
  const db = h.freshDb();
  const [a] = h.addProduct(db, 'A', [['50 ml', 10000, 5000, 10]]);
  h.inventory.receiveStock(db, a, 10, 7000, { reference: 'PO-1' });
  const v = db.prepare('SELECT on_hand, cost FROM product_variants WHERE id = ?').get(a);
  assert.equal(v.on_hand, 20); assert.equal(v.cost, 6000);
});

test('status rules: unpaid online orders cannot be shipped; COD stock leaves on dispatch', () => {
  const db = h.freshDb();
  const [a] = h.addProduct(db, 'A', [['50 ml', 10000, 5000, 5]]);
  const rate = h.addRate(db);
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'cod_enabled'").run(); h.settings.invalidate();
  const online = h.order(db, [[a, 1]], { rateId: rate });
  assert.throws(() => h.orders.setStatus(db, online.id, 'dispatched', {}), /not been paid|cannot be changed/);
  const cod = h.order(db, [[a, 1]], { rateId: rate, paymentMethod: 'cod', phone: '0551234567' });
  assert.equal(cod.status, 'pending_confirmation'); assert.equal(cod.payment_status, 'unpaid');
  h.orders.setStatus(db, cod.id, 'dispatched', {});
  assert.deepEqual(h.stock(db, a), { on_hand: 4, reserved: 1 });   // the online order still holds one
  h.orders.setStatus(db, cod.id, 'delivered', {});
  assert.equal(h.orders.getOrder(db, cod.id).payment_status, 'unpaid');   // stays unpaid until cash is confirmed
  h.payments.collectCod(db, cod.id, null);
  assert.equal(h.orders.getOrder(db, cod.id).payment_status, 'paid');
});
