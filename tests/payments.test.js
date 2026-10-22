'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

function setup(qty = 5, n = 2) {
  const db = h.freshDb();
  const [a] = h.addProduct(db, 'A', [['50 ml', 10000, 4000, qty]]);
  const rate = h.addRate(db, { fee: 3000 });
  const o = h.order(db, [[a, n]], { rateId: rate });
  // pretend Paystack accepted the initialisation
  h.payments.client.request = async (method, path) => ({ data: { authorization_url: 'https://checkout.paystack.com/abc', status: 'success', ...(path.startsWith('/transaction/verify') ? global.__verify || {} : {}) } });
  return { db, a, rate, o };
}
const ref = (db, o) => db.prepare('SELECT reference FROM payments WHERE order_id = ?').get(o.id).reference;

test('initialising a payment records a pending payment with the server-side total', async () => {
  const { db, o } = setup();
  const r = await h.payments.initialize(db, o, 'http://x/cb');
  assert.equal(r.url, 'https://checkout.paystack.com/abc');
  const p = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(o.id);
  assert.equal(p.amount, o.total); assert.equal(p.status, 'pending'); assert.equal(p.reference, `${o.order_no}-1`);
});

test('webhooks with a bad or missing signature are rejected and change nothing', async () => {
  const { db, o } = setup(); await h.payments.initialize(db, o, 'http://x/cb');
  const body = h.chargeEvent(ref(db, o), o.total);
  assert.equal(h.webhook(db, body, 'deadbeef').status, 401);
  assert.equal(h.webhook(db, body, '').status, 401);
  assert.equal(h.orders.getOrder(db, o.id).payment_status, 'pending');
});

test('a signed charge.success marks the order paid and moves stock out', async () => {
  const { db, a, o } = setup(); await h.payments.initialize(db, o, 'http://x/cb');
  assert.equal(h.webhook(db, h.chargeEvent(ref(db, o), o.total)).status, 200);
  const paid = h.orders.getOrder(db, o.id);
  assert.equal(paid.payment_status, 'paid'); assert.equal(paid.status, 'paid'); assert.equal(paid.stock_state, 'deducted');
  assert.deepEqual(h.stock(db, a), { on_hand: 3, reserved: 0 });
  const pay = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(o.id);
  assert.equal(pay.status, 'success'); assert.equal(pay.channel, 'mobile_money'); assert.equal(pay.fee, 150);
});

test('duplicate webhooks are ignored (stock is deducted once)', async () => {
  const { db, a, o } = setup(); await h.payments.initialize(db, o, 'http://x/cb');
  const body = h.chargeEvent(ref(db, o), o.total);
  h.webhook(db, body); const again = h.webhook(db, body);
  assert.equal(again.body, 'duplicate ignored');
  assert.deepEqual(h.stock(db, a), { on_hand: 3, reserved: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM order_events WHERE kind = 'payment' AND status = 'paid'").get().c, 1);
});

test('same payment confirmed by webhook and by verify only counts once', async () => {
  const { db, a, o } = setup(); await h.payments.initialize(db, o, 'http://x/cb');
  const reference = ref(db, o);
  global.__verify = { reference, amount: o.total, currency: 'GHS', status: 'success', id: 55, channel: 'card' };
  const v = await h.payments.verifyReference(db, reference);
  assert.equal(v.status, 'success');
  h.webhook(db, h.chargeEvent(reference, o.total, { id: 777 }));
  assert.deepEqual(h.stock(db, a), { on_hand: 3, reserved: 0 });
  delete global.__verify;
});

test('wrong amount or wrong currency never marks an order paid', async () => {
  const { db, a, o } = setup(); await h.payments.initialize(db, o, 'http://x/cb');
  h.webhook(db, h.chargeEvent(ref(db, o), o.total - 100, { id: 1 }));
  let cur = h.orders.getOrder(db, o.id);
  assert.notEqual(cur.payment_status, 'paid'); assert.match(cur.needs_attention, /mismatch/i);
  const { db: db2, o: o2 } = setup(); await h.payments.initialize(db2, o2, 'http://x/cb');
  h.webhook(db2, h.chargeEvent(ref(db2, o2), o2.total, { currency: 'USD' }));
  assert.notEqual(h.orders.getOrder(db2, o2.id).payment_status, 'paid');
  assert.deepEqual(h.stock(db, a), { on_hand: 5, reserved: 2 });
});

test('unknown references are ignored safely', () => {
  const { db } = setup();
  assert.equal(h.webhook(db, h.chargeEvent('NOT-A-REAL-REF', 1000)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM orders WHERE payment_status = 'paid'").get().c, 0);
});

test('failed payment can be retried with a new reference, and only one attempt can succeed', async () => {
  const { db, o } = setup(); await h.payments.initialize(db, o, 'http://x/cb');
  const first = ref(db, o);
  h.webhook(db, JSON.stringify({ event: 'charge.failed', data: { id: 11, reference: first, amount: o.total } }));
  assert.equal(h.orders.getOrder(db, o.id).payment_status, 'failed');
  await h.payments.initialize(db, h.orders.getOrder(db, o.id), 'http://x/cb');
  const refs = db.prepare('SELECT reference, status FROM payments WHERE order_id = ? ORDER BY id').all(o.id);
  assert.equal(refs.length, 2); assert.equal(refs[1].reference, `${o.order_no}-2`); assert.equal(refs[1].status, 'pending');
  h.webhook(db, h.chargeEvent(refs[1].reference, o.total, { id: 12 }));
  assert.equal(h.orders.getOrder(db, o.id).payment_status, 'paid');
});

test('an already-paid order cannot start another payment', async () => {
  const { db, o } = setup(); await h.payments.initialize(db, o, 'http://x/cb');
  h.webhook(db, h.chargeEvent(ref(db, o), o.total));
  await assert.rejects(() => h.payments.initialize(db, h.orders.getOrder(db, o.id), 'http://x/cb'), /already paid/);
});

test('payment arriving after the reservation expired re-takes stock if still available', async () => {
  const { db, a, o } = setup(); await h.payments.initialize(db, o, 'http://x/cb');
  const reference = ref(db, o);
  h.orders.setStatus(db, o.id, 'cancelled', { note: 'expired' });
  assert.deepEqual(h.stock(db, a), { on_hand: 5, reserved: 0 });
  h.webhook(db, h.chargeEvent(reference, o.total));
  const cur = h.orders.getOrder(db, o.id);
  assert.equal(cur.payment_status, 'paid'); assert.equal(cur.status, 'paid');
  assert.deepEqual(h.stock(db, a), { on_hand: 3, reserved: 0 });
});

test('payment after expiry with no stock left is flagged for the owner, not lost', async () => {
  const { db, a, o } = setup(2, 2); await h.payments.initialize(db, o, 'http://x/cb');
  const reference = ref(db, o);
  h.orders.setStatus(db, o.id, 'cancelled', {});
  const rate = db.prepare('SELECT id FROM delivery_rates LIMIT 1').get().id;
  h.order(db, [[a, 2]], { rateId: rate, phone: '0551112222' });      // someone else takes the stock
  h.webhook(db, h.chargeEvent(reference, o.total));
  const cur = h.orders.getOrder(db, o.id);
  assert.equal(cur.payment_status, 'paid'); assert.match(cur.needs_attention, /no longer in stock/);
});

test('refunds: partial then full, never more than was paid, recorded with user and reason', async () => {
  const { db, o } = setup(); await h.payments.initialize(db, o, 'http://x/cb');
  h.webhook(db, h.chargeEvent(ref(db, o), o.total));
  db.prepare("INSERT INTO users (id,email,name,password_hash,role) VALUES (1,'o@x.com','Owner','x','owner')").run();
  const calls = [];
  h.payments.client.request = async (m, p, body) => { calls.push([m, p, body]); return { data: { id: 'rf_1', status: 'processed' } }; };
  await h.payments.refundOrder(db, o.id, 5000, 'Damaged bottle', 1, 'paystack');
  assert.equal(calls[0][1], '/refund'); assert.equal(calls[0][2].amount, 5000);
  assert.equal(h.orders.getOrder(db, o.id).payment_status, 'partially_refunded');
  await assert.rejects(() => h.payments.refundOrder(db, o.id, o.total, 'too much', 1), /at most/);
  await h.payments.refundOrder(db, o.id, o.total - 5000, 'Rest', 1, 'manual');
  assert.equal(h.orders.getOrder(db, o.id).payment_status, 'refunded');
  assert.equal(calls.length, 1);                                       // manual refund does not call Paystack
  await assert.rejects(() => h.payments.refundOrder(db, o.id, 100, 'again', 1), /Only paid|at most/);
  const r = db.prepare('SELECT * FROM refunds ORDER BY id').all();
  assert.equal(r.length, 2); assert.equal(r[0].user_id, 1); assert.equal(r[0].reason, 'Damaged bottle');
});

test('a Paystack refund failure is recorded as failed and does not change payment status', async () => {
  const { db, o } = setup(); await h.payments.initialize(db, o, 'http://x/cb');
  h.webhook(db, h.chargeEvent(ref(db, o), o.total));
  h.payments.client.request = async () => { throw new Error('insufficient balance'); };
  await assert.rejects(() => h.payments.refundOrder(db, o.id, 1000, 'x', null, 'paystack'), /insufficient balance/);
  assert.equal(db.prepare('SELECT status FROM refunds').get().status, 'failed');
  assert.equal(h.orders.getOrder(db, o.id).payment_status, 'paid');
});

test('cancelling a paid order restores stock and flags it for refund', async () => {
  const { db, a, o } = setup(); await h.payments.initialize(db, o, 'http://x/cb');
  h.webhook(db, h.chargeEvent(ref(db, o), o.total));
  h.orders.setStatus(db, o.id, 'cancelled', {});
  assert.deepEqual(h.stock(db, a), { on_hand: 5, reserved: 0 });
  assert.match(h.orders.getOrder(db, o.id).needs_attention, /refund/i);
});

test('returns put stock back only when the owner says it is resaleable', async () => {
  const { db, a, o } = setup(); await h.payments.initialize(db, o, 'http://x/cb');
  h.webhook(db, h.chargeEvent(ref(db, o), o.total));
  for (const s of ['processing', 'packed', 'dispatched', 'delivered', 'return_requested']) h.orders.setStatus(db, o.id, s, {});
  h.orders.setStatus(db, o.id, 'returned', { restock: false });
  assert.deepEqual(h.stock(db, a), { on_hand: 3, reserved: 0 });
  const o2 = (() => { const rate = db.prepare('SELECT id FROM delivery_rates LIMIT 1').get().id; return h.order(db, [[a, 1]], { rateId: rate, phone: '0551112222' }); })();
  h.payments.client.request = async () => ({ data: { authorization_url: 'https://x', status: 'success' } });
  return h.payments.initialize(db, o2, 'x').then(() => {
    h.webhook(db, h.chargeEvent(ref(db, o2), o2.total, { id: 2 }));
    for (const s of ['processing', 'dispatched', 'delivered', 'return_requested']) h.orders.setStatus(db, o2.id, s, {});
    h.orders.setStatus(db, o2.id, 'returned', { restock: true });
    assert.deepEqual(h.stock(db, a), { on_hand: 3, reserved: 0 });
  });
});

test('reports: sales only count paid orders; profit uses recorded cost; refunds and expenses reduce it', async () => {
  const { db, o } = setup(); await h.payments.initialize(db, o, 'http://x/cb');
  const reports = require('../src/services/reports');
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(reports.profit(db, day, day).orders, 0);               // not paid yet
  h.webhook(db, h.chargeEvent(ref(db, o), o.total));
  db.prepare("INSERT INTO expenses (category, amount) VALUES ('Packaging', 500)").run();
  const p = reports.profit(db, day, day);
  assert.equal(p.orders, 1); assert.equal(p.netSales, 20000); assert.equal(p.cogs, 8000); assert.equal(p.grossProfit, 12000);
  assert.equal(p.deliveryFees, 3000); assert.equal(p.paymentFees, 150); assert.equal(p.operatingExpenses, 500);
  assert.equal(p.netProfit, 12000 + 3000 - 150 - 500);
  assert.equal(p.isEstimate, false);
});
