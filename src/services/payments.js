'use strict';
/**
 * Payments (Paystack).
 *  - The payment is started from the server (initialize).
 *  - An order is only marked PAID after the server has confirmed it with Paystack
 *    (verify API call) or received a correctly SIGNED webhook, and the amount,
 *    currency and reference all match our own records.
 *  - Landing on the "success" page never marks anything as paid.
 *  - Every provider event is stored once (UNIQUE key) so repeats are ignored.
 */
const crypto = require('crypto');
const config = require('../config');
const inventory = require('./inventory');
const orders = require('./orders');
const util = require('../lib/util');
const notify = require('./notify');

/* ---------- HTTP client (replaceable in tests) ---------- */
const client = {
  async request(method, path, body) {
    if (!config.paystack.secretKey) throw new Error('Paystack is not configured (PAYSTACK_SECRET_KEY missing).');
    const res = await fetch(config.paystack.baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${config.paystack.secretKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok || !json) {
      const err = new Error((json && json.message) || `Paystack error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }
};

function verifySignature(rawBody, signature, secret = config.paystack.secretKey) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  return util.safeEqual(expected, signature);
}

function newReference(db, order) {
  const n = db.prepare('SELECT COUNT(*) c FROM payments WHERE order_id = ?').get(order.id).c + 1;
  return `${order.order_no}-${n}`;
}

/** Start (or restart) an online payment. Returns the Paystack-hosted payment page URL. */
async function initialize(db, order, callbackUrl) {
  if (order.payment_method !== 'paystack') throw new Error('This order is not an online-payment order.');
  if (order.payment_status === 'paid') throw new Error('This order is already paid.');
  if (['cancelled', 'refunded'].includes(order.status)) throw new Error('This order was cancelled.');

  // Earlier unfinished attempts are closed so only the newest one can complete.
  db.prepare("UPDATE payments SET status = 'abandoned' WHERE order_id = ? AND status = 'pending'").run(order.id);
  const reference = newReference(db, order);
  db.prepare(`INSERT INTO payments (order_id, provider, reference, amount, currency, status) VALUES (?,?,?,?,?, 'pending')`)
    .run(order.id, 'paystack', reference, order.total, order.currency);

  const res = await client.request('POST', '/transaction/initialize', {
    email: order.customer_email,
    amount: order.total,                 // Paystack uses the smallest unit (pesewas)
    currency: order.currency,
    reference,
    callback_url: callbackUrl,
    // No channel list: Paystack shows the payment methods enabled on your account (Mobile Money, card, bank transfer…).
    metadata: { order_no: order.order_no, order_id: order.id }
  });
  const url = res.data && res.data.authorization_url;
  if (!url) throw new Error('Paystack did not return a payment link.');
  db.prepare('UPDATE payments SET authorization_url = ? WHERE reference = ?').run(url, reference);
  db.prepare("UPDATE orders SET payment_status = 'pending', updated_at = datetime('now') WHERE id = ? AND payment_status != 'paid'").run(order.id);
  return { url, reference };
}

/** Record an event once. Returns false if we have already seen it. */
function recordEvent(db, provider, key, type, reference, payload, outcome) {
  const r = db.prepare('INSERT OR IGNORE INTO payment_events (provider, event_key, event_type, reference, outcome, payload) VALUES (?,?,?,?,?,?)')
    .run(provider, key, type, reference || null, outcome || null, payload ? JSON.stringify(payload).slice(0, 20000) : null);
  return r.changes === 1;
}

/**
 * Apply a successful charge to an order. `data` is Paystack's transaction object.
 * Safe to call many times: it only acts the first time.
 */
function applySuccess(db, data) {
  return db.transaction(() => {
    const payment = db.prepare('SELECT * FROM payments WHERE reference = ?').get(data.reference);
    if (!payment) return { ok: false, reason: 'unknown_reference' };
    const order = orders.getOrder(db, payment.order_id);
    if (payment.status === 'success') return { ok: true, duplicate: true, order };

    // Never trust the status alone: the amount, currency and reference must all match.
    if (Number(data.amount) !== Number(payment.amount) || Number(data.amount) !== Number(order.total)) {
      db.prepare("UPDATE orders SET needs_attention = ? WHERE id = ?").run(`Payment amount mismatch on ${data.reference}: paid ${data.amount}, expected ${order.total}. Check Paystack before shipping.`, order.id);
      db.prepare("UPDATE payments SET status = 'failed' WHERE id = ?").run(payment.id);
      return { ok: false, reason: 'amount_mismatch', order };
    }
    if (String(data.currency || '').toUpperCase() !== String(payment.currency).toUpperCase()) {
      db.prepare("UPDATE orders SET needs_attention = ? WHERE id = ?").run(`Payment currency mismatch on ${data.reference}.`, order.id);
      db.prepare("UPDATE payments SET status = 'failed' WHERE id = ?").run(payment.id);
      return { ok: false, reason: 'currency_mismatch', order };
    }

    db.prepare(`UPDATE payments SET status = 'success', channel = ?, fee = ?, provider_txn_id = ?, paid_at = COALESCE(?, datetime('now')) WHERE id = ?`)
      .run(data.channel || null, Number(data.fees) || 0, data.id ? String(data.id) : null,
        data.paid_at ? String(data.paid_at).slice(0, 19).replace('T', ' ') : null, payment.id);
    // Any other attempts for this order are now pointless.
    db.prepare("UPDATE payments SET status = 'abandoned' WHERE order_id = ? AND id != ? AND status = 'pending'").run(order.id, payment.id);

    let revived = false;
    if (order.stock_state === 'released' || order.status === 'cancelled') {
      // Customer paid after we released their stock. Try to take it back.
      try {
        inventory.reserveForOrder(db, order.id);
        revived = true;
      } catch (e) {
        db.prepare("UPDATE orders SET payment_status = 'paid', needs_attention = ? WHERE id = ?")
          .run('Paid after the reservation expired and the item is no longer in stock. Contact the customer or refund.', order.id);
        orders.addEvent(db, order.id, { kind: 'payment', note: 'Payment received after expiry; stock unavailable.' });
        return { ok: true, order: orders.getOrder(db, order.id), oversold: true };
      }
    }
    if (order.stock_state === 'reserved' || revived) inventory.commitOrder(db, order.id);
    if (revived) {
      orders.addEvent(db, order.id, { kind: 'stock', note: 'Payment arrived after the order was cancelled/expired. Stock was taken again and the order re-opened.' });
    }

    db.prepare(`UPDATE orders SET payment_status = 'paid', status = CASE WHEN status IN ('payment_pending','pending_confirmation','cancelled') THEN 'paid' ELSE status END,
      needs_attention = CASE WHEN needs_attention LIKE 'Payment amount%' THEN NULL ELSE needs_attention END,
      updated_at = datetime('now') WHERE id = ?`).run(order.id);
    orders.addEvent(db, order.id, { kind: 'payment', status: 'paid', note: `Payment confirmed (${data.channel || 'online'}) ref ${data.reference}` });
    const fresh = orders.getOrder(db, order.id);
    setImmediate(() => { try { notify.orderPaid(db, fresh); } catch (e) { /* database may be closed */ } });
    return { ok: true, order: fresh, revived };
  })();
}

function applyFailure(db, reference, outcome) {
  return db.transaction(() => {
    const payment = db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
    if (!payment || payment.status === 'success') return;
    const status = outcome === 'abandoned' ? 'cancelled' : 'failed';
    db.prepare('UPDATE payments SET status = ? WHERE id = ?').run(status, payment.id);
    const o = orders.getOrder(db, payment.order_id);
    if (o && o.payment_status !== 'paid') {
      db.prepare("UPDATE orders SET payment_status = ?, updated_at = datetime('now') WHERE id = ?").run(status === 'cancelled' ? 'cancelled' : 'failed', o.id);
      orders.addEvent(db, o.id, { kind: 'payment', note: `Payment ${status} (${reference})` });
    }
  })();
}

/** Ask Paystack directly what happened. Used on the return page and by "check payment". */
async function verifyReference(db, reference) {
  const payment = db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
  if (!payment) return { status: 'unknown' };
  if (payment.status === 'success') return { status: 'success', order: orders.getOrder(db, payment.order_id) };
  let res;
  try { res = await client.request('GET', `/transaction/verify/${encodeURIComponent(reference)}`); }
  catch (e) { return { status: 'error', message: e.message, order: orders.getOrder(db, payment.order_id) }; }
  const data = res.data || {};
  recordEvent(db, 'paystack', `verify:${reference}:${data.status}`, 'verify', reference, { status: data.status, amount: data.amount }, data.status);
  if (data.status === 'success') {
    const r = applySuccess(db, data);
    return { status: r.ok ? 'success' : 'error', message: r.reason, order: r.order };
  }
  if (data.status === 'failed' || data.status === 'abandoned') {
    if (data.status === 'failed') applyFailure(db, reference, 'failed');
    return { status: data.status, order: orders.getOrder(db, payment.order_id) };
  }
  return { status: 'pending', order: orders.getOrder(db, payment.order_id) };
}

/** Handle a webhook. rawBody must be the exact bytes Paystack sent. */
function handleWebhook(db, rawBody, signature) {
  if (!verifySignature(rawBody, signature)) return { status: 401, body: 'invalid signature' };
  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch (e) { return { status: 400, body: 'bad json' }; }
  const data = event.data || {};
  const reference = data.reference || (data.transaction && data.transaction.reference) || null;
  const key = `${event.event}:${data.id || reference || crypto.createHash('sha256').update(rawBody).digest('hex')}`;
  const fresh = recordEvent(db, 'paystack', key, event.event, reference, { event: event.event, status: data.status, amount: data.amount });
  if (!fresh) return { status: 200, body: 'duplicate ignored' };   // already handled

  if (event.event === 'charge.success') {
    applySuccess(db, data);
  } else if (event.event === 'charge.failed') {
    if (reference) applyFailure(db, reference, 'failed');
  } else if (event.event === 'refund.processed' || event.event === 'refund.failed') {
    const txRef = data.transaction_reference || (data.transaction && data.transaction.reference);
    if (txRef) {
      const pay = db.prepare('SELECT * FROM payments WHERE reference = ?').get(txRef);
      if (pay) {
        const refund = db.prepare("SELECT * FROM refunds WHERE payment_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(pay.id);
        if (refund) {
          db.prepare('UPDATE refunds SET status = ?, provider_ref = COALESCE(?, provider_ref) WHERE id = ?')
            .run(event.event === 'refund.processed' ? 'processed' : 'failed', data.id ? String(data.id) : null, refund.id);
          if (event.event === 'refund.processed') finaliseRefundTotals(db, pay.order_id);
        }
      }
    }
  }
  return { status: 200, body: 'ok' };
}

/* ---------- cash on delivery ---------- */
function collectCod(db, orderId, userId) {
  return db.transaction(() => {
    const o = orders.getOrder(db, orderId);
    if (!o || o.payment_method !== 'cod') throw new orders.OrderError('This is not a pay-on-delivery order.');
    if (o.payment_status === 'paid') throw new orders.OrderError('Already marked as paid.');
    if (['cancelled', 'refunded'].includes(o.status)) throw new orders.OrderError('This order is cancelled.');
    const ref = `${o.order_no}-COD`;
    db.prepare(`INSERT INTO payments (order_id, provider, reference, amount, currency, status, channel, paid_at) VALUES (?, 'cod', ?, ?, ?, 'success', 'cash', datetime('now'))`)
      .run(o.id, ref, o.total, o.currency);
    db.prepare("UPDATE orders SET payment_status = 'paid', updated_at = datetime('now') WHERE id = ?").run(o.id);
    orders.addEvent(db, o.id, { kind: 'payment', note: 'Cash collected', userId });
  })();
}

/* ---------- refunds ---------- */
function refundedSoFar(db, orderId) {
  return db.prepare("SELECT COALESCE(SUM(amount),0) s FROM refunds WHERE order_id = ? AND status IN ('processed','pending')").get(orderId).s;
}

function finaliseRefundTotals(db, orderId) {
  const o = orders.getOrder(db, orderId);
  const done = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM refunds WHERE order_id = ? AND status = 'processed'").get(orderId).s;
  if (done <= 0) return;
  const full = done >= o.total;
  db.prepare("UPDATE orders SET payment_status = ?, updated_at = datetime('now') WHERE id = ?").run(full ? 'refunded' : 'partially_refunded', orderId);
  db.prepare("UPDATE payments SET status = ? WHERE order_id = ? AND status IN ('success','partially_refunded')").run(full ? 'refunded' : 'partially_refunded', orderId);
  if (full && ['returned', 'cancelled', 'paid', 'delivered', 'return_requested'].includes(o.status) && o.status !== 'refunded') {
    if (o.status === 'returned') {
      db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(orderId);
      orders.addEvent(db, orderId, { status: 'refunded', note: 'Fully refunded' });
    } else {
      orders.addEvent(db, orderId, { kind: 'payment', note: 'Fully refunded' });
    }
  }
  db.prepare("UPDATE orders SET needs_attention = NULL WHERE id = ? AND needs_attention LIKE '%refund%'").run(orderId);
}

/**
 * Refund an order (whole or part). Online payments go through Paystack;
 * 'manual' records a refund you paid by hand (e.g. Mobile Money transfer, or cash on delivery).
 */
async function refundOrder(db, orderId, amount, reason, userId, method) {
  const o = orders.getOrder(db, orderId);
  if (!o) throw new orders.OrderError('Order not found.');
  if (o.payment_status !== 'paid' && o.payment_status !== 'partially_refunded') throw new orders.OrderError('Only paid orders can be refunded.');
  if (!(amount > 0)) throw new orders.OrderError('Enter a refund amount greater than zero.');
  const remaining = o.total - refundedSoFar(db, orderId);
  if (amount > remaining) throw new orders.OrderError(`You can refund at most ${(remaining / 100).toFixed(2)} on this order.`);
  const payment = db.prepare("SELECT * FROM payments WHERE order_id = ? AND status IN ('success','partially_refunded') ORDER BY id DESC LIMIT 1").get(orderId);
  if (!payment) throw new orders.OrderError('No successful payment found for this order.');

  const viaPaystack = payment.provider === 'paystack' && method !== 'manual';
  const refundId = Number(db.prepare('INSERT INTO refunds (order_id, payment_id, amount, reason, method, status, user_id) VALUES (?,?,?,?,?,?,?)')
    .run(orderId, payment.id, amount, reason || null, viaPaystack ? 'paystack' : 'manual', viaPaystack ? 'pending' : 'processed', userId || null).lastInsertRowid);

  if (viaPaystack) {
    try {
      const res = await client.request('POST', '/refund', { transaction: payment.reference, amount, currency: payment.currency, merchant_note: reason || 'Refund' });
      const st = res.data && res.data.status;
      db.prepare('UPDATE refunds SET provider_ref = ?, status = ? WHERE id = ?')
        .run(res.data && res.data.id ? String(res.data.id) : null, st === 'processed' ? 'processed' : 'pending', refundId);
    } catch (e) {
      db.prepare("UPDATE refunds SET status = 'failed' WHERE id = ?").run(refundId);
      throw new orders.OrderError(`Paystack could not process the refund: ${e.message}`);
    }
  }
  finaliseRefundTotals(db, orderId);
  orders.addEvent(db, orderId, { kind: 'payment', note: `Refund of ${(amount / 100).toFixed(2)} recorded${viaPaystack ? ' via Paystack' : ' (manual)'}. ${reason || ''}`.trim(), userId });
  return db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
}

module.exports = { client, verifySignature, initialize, verifyReference, handleWebhook, applySuccess, applyFailure, collectCod, refundOrder, refundedSoFar, recordEvent };
