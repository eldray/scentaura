'use strict';
process.env.MOMO_ENV = 'sandbox';
process.env.MOMO_SUBSCRIPTION_KEY = 'sub-key';
process.env.MOMO_API_USER = '11111111-1111-4111-8111-111111111111';
process.env.MOMO_API_KEY = 'api-key';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const momo = require('../src/services/momo');
const config = require('../src/config');

/** A tiny pretend MTN server. */
function fakeMtn(state = {}) {
  const calls = [];
  momo.client.request = async (method, path, o = {}) => {
    calls.push({ method, path, o });
    if (path === '/collection/token/') return { status: 200, json: { access_token: 'tok', expires_in: 3600 } };
    if (method === 'POST' && path === '/collection/v1_0/requesttopay') return state.reject ? { status: 500, json: { message: 'boom' } } : { status: 202, json: null };
    if (method === 'GET' && path.startsWith('/collection/v1_0/requesttopay/')) {
      const ref = decodeURIComponent(path.split('/').pop());
      return { status: 200, json: { status: state.status || 'PENDING', amount: state.amount, currency: state.currency || config.momo.currency, financialTransactionId: '555', externalId: 'x', reason: state.reason, _ref: ref } };
    }
    return { status: 404, json: null };
  };
  momo.resetToken();
  return calls;
}

function setup() {
  const db = h.freshDb();
  const [a] = h.addProduct(db, 'A', [['50 ml', 10000, 4000, 5]]);
  const rate = h.addRate(db, { fee: 3000 });
  const o = h.order(db, [[a, 2]], { rateId: rate, paymentMethod: 'momo' });
  return { db, a, o };
}
const ref = (db, o) => db.prepare("SELECT reference FROM payments WHERE order_id = ? ORDER BY id DESC").get(o.id).reference;

test('MoMo is enabled only when all three keys are set', () => assert.equal(config.momoEnabled(), true));

test('a request to pay is sent with the server-side total and the right phone format', async () => {
  const { db, o } = setup(); const calls = fakeMtn();
  const r = await momo.initialize(db, o, '024 123 4567');
  assert.match(r.reference, /^[0-9a-f-]{36}$/);
  const send = calls.find(c => c.path === '/collection/v1_0/requesttopay');
  assert.equal(send.o.body.amount, (o.total / 100).toFixed(2));
  assert.equal(send.o.body.payer.partyId, '233241234567');
  assert.equal(send.o.body.payer.partyIdType, 'MSISDN');
  assert.equal(send.o.headers['X-Reference-Id'], r.reference);
  assert.equal(send.o.auth, 'Bearer tok');
  const p = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(o.id);
  assert.equal(p.status, 'pending'); assert.equal(p.amount, o.total); assert.equal(p.payer_phone, '+233241234567');
  assert.equal(h.orders.getOrder(db, o.id).payment_status, 'pending');
});

test('a bad phone number is refused before MTN is called', async () => {
  const { db, o } = setup(); const calls = fakeMtn();
  await assert.rejects(() => momo.initialize(db, o, '12345'), /valid MTN/);
  assert.equal(calls.length, 0);
});

test('if MTN rejects the request the attempt is marked failed', async () => {
  const { db, o } = setup(); fakeMtn({ reject: true });
  await assert.rejects(() => momo.initialize(db, o, '0241234567'), /did not accept/);
  assert.equal(db.prepare('SELECT status FROM payments WHERE order_id = ?').get(o.id).status, 'failed');
});

test('PENDING keeps waiting and never marks the order paid', async () => {
  const { db, o } = setup(); fakeMtn({ status: 'PENDING' });
  await momo.initialize(db, o, '0241234567');
  const r = await momo.verifyReference(db, ref(db, o));
  assert.equal(r.status, 'pending');
  assert.equal(h.orders.getOrder(db, o.id).payment_status, 'pending');
});

test('SUCCESSFUL with the right amount marks the order paid once and takes stock', async () => {
  const { db, a, o } = setup(); fakeMtn({ status: 'SUCCESSFUL', amount: (o.total / 100).toFixed(2) });
  await momo.initialize(db, o, '0241234567');
  const r = await momo.verifyReference(db, ref(db, o));
  assert.equal(r.status, 'success');
  const paid = h.orders.getOrder(db, o.id);
  assert.equal(paid.payment_status, 'paid'); assert.equal(paid.status, 'paid'); assert.equal(paid.stock_state, 'deducted');
  assert.deepEqual(h.stock(db, a), { on_hand: 3, reserved: 0 });
  assert.equal(db.prepare('SELECT provider_txn_id FROM payments WHERE order_id = ?').get(o.id).provider_txn_id, '555');
  assert.equal((await momo.verifyReference(db, ref(db, o))).status, 'success');       // repeat is harmless
  assert.deepEqual(h.stock(db, a), { on_hand: 3, reserved: 0 });
});

test('SUCCESSFUL with the wrong amount or currency is NOT accepted', async () => {
  let { db, o } = setup(); fakeMtn({ status: 'SUCCESSFUL', amount: '1.00' });
  await momo.initialize(db, o, '0241234567');
  assert.equal((await momo.verifyReference(db, ref(db, o))).status, 'error');
  assert.notEqual(h.orders.getOrder(db, o.id).payment_status, 'paid');
  assert.match(h.orders.getOrder(db, o.id).needs_attention, /mismatch/);
  ({ db, o } = setup()); fakeMtn({ status: 'SUCCESSFUL', amount: (o.total / 100).toFixed(2), currency: 'USD' });
  await momo.initialize(db, o, '0241234567');
  assert.equal((await momo.verifyReference(db, ref(db, o))).status, 'error');
  assert.notEqual(h.orders.getOrder(db, o.id).payment_status, 'paid');
});

test('FAILED records a friendly reason and lets the customer try again', async () => {
  const { db, o } = setup(); fakeMtn({ status: 'FAILED', reason: 'NOT_ENOUGH_FUNDS' });
  await momo.initialize(db, o, '0241234567');
  const r = await momo.verifyReference(db, ref(db, o));
  assert.equal(r.status, 'failed'); assert.match(r.reason, /not enough money/);
  assert.equal(h.orders.getOrder(db, o.id).payment_status, 'failed');
  fakeMtn({ status: 'PENDING' });
  await momo.initialize(db, h.orders.getOrder(db, o.id), '0201112222');    // retry with another number
  assert.equal(db.prepare('SELECT COUNT(*) c FROM payments WHERE order_id = ?').get(o.id).c, 2);
});

test('the callback is only a nudge: unknown references are ignored, known ones are re-checked with MTN', async () => {
  const { db, o } = setup(); const calls = fakeMtn({ status: 'SUCCESSFUL', amount: (o.total / 100).toFixed(2) });
  await momo.initialize(db, o, '0241234567');
  assert.equal((await momo.handleCallback(db, 'not-a-uuid')).status, 400);
  assert.equal((await momo.handleCallback(db, '22222222-2222-4222-8222-222222222222')).body, 'ignored');
  assert.notEqual(h.orders.getOrder(db, o.id).payment_status, 'paid');
  await momo.handleCallback(db, ref(db, o));
  assert.equal(h.orders.getOrder(db, o.id).payment_status, 'paid');
  assert.ok(calls.some(c => c.method === 'GET'));
});

test('an expired token is refreshed once', async () => {
  const { db, o } = setup(); let first = true; const calls = fakeMtn({ status: 'PENDING' });
  const base = momo.client.request;
  momo.client.request = async (m, p, op) => { if (p.includes('requesttopay') && first) { first = false; return { status: 401, json: null }; } return base(m, p, op); };
  await momo.initialize(db, o, '0241234567');
  assert.equal(calls.filter(c => c.path === '/collection/token/').length, 2);
});

test('Mobile Money orders cannot be shipped before payment, and refunds are recorded by hand', async () => {
  const { db, o } = setup(); fakeMtn({ status: 'SUCCESSFUL', amount: (o.total / 100).toFixed(2) });
  assert.throws(() => h.orders.setStatus(db, o.id, 'processing'), /cannot be changed|not been paid/);
  await momo.initialize(db, o, '0241234567'); await momo.verifyReference(db, ref(db, o));
  const r = await h.payments.refundOrder(db, o.id, 5000, 'Damaged', null, 'paystack');
  assert.equal(r.method, 'manual'); assert.equal(r.status, 'processed');
});

test('an old database is upgraded in place so it accepts Mobile Money', () => {
  const fs = require('fs'), path = require('path'), dbm = require('../src/db');
  const old = fs.readFileSync(path.join(__dirname, '../src/schema.sql'), 'utf8')
    .replace("('paystack','momo','cod')", "('paystack','cod')").replace("('paystack','momo','manual')", "('paystack','manual')")
    .replace('  payer_phone TEXT,\n', '').replace('  failure_reason TEXT,\n', '');
  const conn = dbm.open(':memory:');
  conn.exec(old);
  assert.throws(() => conn.prepare("INSERT INTO refunds (order_id, amount, method) VALUES (1, 5, 'momo')").run());
  dbm.migrate(conn);
  const sql = t => conn.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t).sql;
  assert.match(sql('orders'), /'paystack','momo','cod'/);
  assert.match(sql('refunds'), /'paystack','momo','manual'/);
  assert.ok(conn.prepare('PRAGMA table_info(payments)').all().some(c => c.name === 'payer_phone'));
  assert.equal(conn.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  dbm.migrate(conn);       // running it again changes nothing
  conn.close();
});
