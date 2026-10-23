'use strict';
/**
 * MTN Mobile Money (MoMo) "Collection" API – Request to Pay.
 *
 * Flow:
 *  1. We ask MTN to send a payment request (a pop-up / USSD prompt) to the customer's phone.
 *  2. The customer approves it with their MoMo PIN. We never see the PIN.
 *  3. We ask MTN for the result (status API). Only a status of SUCCESSFUL, with the amount and
 *     currency matching our own records, marks an order as paid. MTN's callback is only a "nudge":
 *     it is never trusted by itself, we always re-ask MTN.
 *
 * Money is kept in pesewas inside the shop and converted to a decimal string (e.g. "150.00") for MTN.
 */
const crypto = require('crypto');
const config = require('../config');
const orders = require('./orders');
const payments = require('./payments');
const util = require('../lib/util');

let tokenCache = { token: null, expires: 0 };

/* ---------- HTTP client (replaceable in tests) ---------- */
const client = {
  async request(method, path, { body, headers, auth } = {}) {
    const m = config.momo;
    if (!config.momoEnabled()) throw new Error('Mobile Money is not configured (MOMO_* settings missing).');
    const res = await fetch(m.baseUrl + path, {
      method,
      headers: {
        'Ocp-Apim-Subscription-Key': m.subscriptionKey,
        'X-Target-Environment': m.env,
        ...(auth ? { Authorization: auth } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* many MoMo answers have no body */ }
    return { status: res.status, json };
  }
};

async function accessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expires) return tokenCache.token;
  const basic = 'Basic ' + Buffer.from(`${config.momo.apiUser}:${config.momo.apiKey}`).toString('base64');
  const r = await client.request('POST', '/collection/token/', { auth: basic });
  if (r.status !== 200 && r.status !== 201) throw new Error(`MoMo sign-in failed (${r.status}). Check MOMO_API_USER, MOMO_API_KEY and MOMO_SUBSCRIPTION_KEY.`);
  if (!r.json || !r.json.access_token) throw new Error('MoMo did not return an access token.');
  tokenCache = { token: r.json.access_token, expires: Date.now() + Math.max(60, (r.json.expires_in || 3600) - 120) * 1000 };
  return tokenCache.token;
}

function resetToken() { tokenCache = { token: null, expires: 0 }; }

/** Authorised call; retries once with a fresh token if MTN says the token is no longer valid. */
async function call(method, path, opts = {}) {
  let r = await client.request(method, path, { ...opts, auth: 'Bearer ' + await accessToken() });
  if (r.status === 401) { resetToken(); r = await client.request(method, path, { ...opts, auth: 'Bearer ' + await accessToken() }); }
  return r;
}

/** +233241234567 -> 233241234567 (MTN wants digits only, with country code). */
function toMsisdn(phone) {
  const p = util.normalizeGhPhone(phone);
  return p ? p.replace('+', '') : null;
}

/** 15000 pesewas -> "150.00" */
const toMajor = pesewas => (pesewas / 100).toFixed(2);
/** "150.00" -> 15000 */
const toPesewas = str => Math.round(parseFloat(str) * 100);

function newReference(db, order) {
  return crypto.randomUUID();   // MTN requires a UUID v4 as the transaction reference
}

/** Human-friendly reasons MTN returns on a FAILED payment. */
const REASONS = {
  PAYER_NOT_FOUND: 'That number is not registered for MTN Mobile Money.',
  NOT_ENOUGH_FUNDS: 'There was not enough money in the wallet.',
  PAYER_LIMIT_REACHED: 'The wallet limit has been reached.',
  PAYEE_NOT_ALLOWED_TO_RECEIVE: 'The shop cannot receive this payment right now.',
  NOT_ALLOWED: 'This payment is not allowed for that wallet.',
  NOT_ALLOWED_TARGET_ENVIRONMENT: 'This payment is not allowed in this environment.',
  INVALID_CALLBACK_URL_HOST: 'The shop callback address is not accepted by MTN.',
  EXPIRED: 'The payment request expired before it was approved.',
  TRANSACTION_CANCELED: 'The payment was cancelled.',
  APPROVAL_REJECTED: 'The payment was declined on the phone.',
  INTERNAL_PROCESSING_ERROR: 'MTN had a problem. Please try again.',
  SERVICE_UNAVAILABLE: 'MTN Mobile Money is not available right now. Please try again.'
};
const friendlyReason = r => REASONS[r] || (r ? `MTN reported: ${String(r).slice(0, 80)}` : 'The payment was not completed.');

/**
 * Start a payment: MTN pushes an approval prompt to `phone`.
 * Returns { reference }. The order is paid only later, after MTN reports SUCCESSFUL.
 */
async function initialize(db, order, phone) {
  if (order.payment_method !== 'momo') throw new Error('This order is not a Mobile Money order.');
  if (order.payment_status === 'paid') throw new Error('This order is already paid.');
  if (['cancelled', 'refunded'].includes(order.status)) throw new Error('This order was cancelled.');
  const msisdn = toMsisdn(phone);
  if (!msisdn) throw new orders.OrderError('Please enter a valid MTN Mobile Money number, for example 024 123 4567.');

  db.prepare("UPDATE payments SET status = 'abandoned' WHERE order_id = ? AND status = 'pending'").run(order.id);
  const reference = newReference(db, order);
  db.prepare(`INSERT INTO payments (order_id, provider, reference, amount, currency, status, channel, payer_phone) VALUES (?,?,?,?,?, 'pending', 'mtn_momo', ?)`)
    .run(order.id, 'momo', reference, order.total, config.momo.currency, '+' + msisdn);

  const callback = /^https:\/\//.test(config.baseUrl) ? { 'X-Callback-Url': `${config.baseUrl}/webhooks/momo/${reference}` } : {};
  let r;
  try {
    r = await call('POST', '/collection/v1_0/requesttopay', {
      headers: { 'X-Reference-Id': reference, ...callback },
      body: {
        amount: toMajor(order.total),
        currency: config.momo.currency,
        externalId: order.order_no,
        payer: { partyIdType: 'MSISDN', partyId: msisdn },
        payerMessage: `ScentAura order ${order.order_no}`.slice(0, 50),
        payeeNote: `Order ${order.order_no}`.slice(0, 50)
      }
    });
  } catch (e) {
    db.prepare("UPDATE payments SET status = 'failed', failure_reason = ? WHERE reference = ?").run(e.message.slice(0, 200), reference);
    throw e;
  }
  if (r.status !== 202) {
    const why = (r.json && (r.json.message || r.json.code)) || `status ${r.status}`;
    db.prepare("UPDATE payments SET status = 'failed', failure_reason = ? WHERE reference = ?").run(String(why).slice(0, 200), reference);
    payments.recordEvent(db, 'momo', `init:${reference}`, 'init_failed', reference, { status: r.status, body: r.json }, 'failed');
    throw new Error(`MTN did not accept the payment request (${why}).`);
  }
  payments.recordEvent(db, 'momo', `init:${reference}`, 'requested', reference, { status: 202 }, 'pending');
  db.prepare("UPDATE orders SET payment_status = 'pending', updated_at = datetime('now') WHERE id = ? AND payment_status != 'paid'").run(order.id);
  orders.addEvent(db, order.id, { kind: 'payment', note: `Mobile Money request sent to ${'+' + msisdn}` });
  return { reference };
}

/** Ask MTN what happened to a payment request and update our records. */
async function verifyReference(db, reference) {
  const payment = db.prepare('SELECT * FROM payments WHERE reference = ? AND provider = ?').get(reference, 'momo');
  if (!payment) return { status: 'unknown' };
  const order = () => orders.getOrder(db, payment.order_id);
  if (payment.status === 'success') return { status: 'success', order: order() };

  let r;
  try { r = await call('GET', `/collection/v1_0/requesttopay/${encodeURIComponent(reference)}`, { headers: { 'X-Reference-Id': reference } }); }
  catch (e) { return { status: 'error', message: e.message, order: order() }; }
  if (r.status === 404) return { status: 'pending', order: order() };           // MTN has not registered it (yet)
  if (r.status !== 200 || !r.json) return { status: 'error', message: `MTN status ${r.status}`, order: order() };

  const d = r.json;
  payments.recordEvent(db, 'momo', `status:${reference}:${d.status}:${d.reason || ''}`, 'status', reference, { status: d.status, amount: d.amount, currency: d.currency, reason: d.reason }, d.status);

  if (d.status === 'SUCCESSFUL') {
    const res = payments.applySuccess(db, {
      reference,
      amount: toPesewas(d.amount),
      currency: d.currency,
      channel: 'mtn_momo',
      id: d.financialTransactionId || null,
      fees: 0
    });
    return { status: res.ok ? 'success' : 'error', message: res.reason, order: res.order || order() };
  }
  if (d.status === 'FAILED') {
    const reason = friendlyReason(typeof d.reason === 'object' && d.reason ? d.reason.code || d.reason.message : d.reason);
    db.prepare('UPDATE payments SET failure_reason = ? WHERE id = ?').run(reason, payment.id);
    payments.applyFailure(db, reference, 'failed');
    return { status: 'failed', reason, order: order() };
  }
  return { status: 'pending', order: order() };   // MTN says PENDING: waiting for the customer
}

/**
 * MTN calls this address when a request finishes. The call is NOT signed, so we ignore what it says
 * and just re-check with MTN directly. Unknown references are ignored.
 */
async function handleCallback(db, reference) {
  if (!/^[0-9a-f-]{36}$/i.test(reference || '')) return { status: 400, body: 'bad reference' };
  const known = db.prepare("SELECT 1 FROM payments WHERE reference = ? AND provider = 'momo'").get(reference);
  if (!known) return { status: 200, body: 'ignored' };
  await verifyReference(db, reference);
  return { status: 200, body: 'ok' };
}

/** The newest Mobile Money attempt for an order, as shown to the customer. */
function latestAttempt(db, orderId) {
  return db.prepare("SELECT reference, status, payer_phone, failure_reason, created_at FROM payments WHERE order_id = ? AND provider = 'momo' ORDER BY id DESC LIMIT 1").get(orderId) || null;
}

module.exports = { client, initialize, verifyReference, handleCallback, latestAttempt, toMsisdn, toMajor, toPesewas, friendlyReason, resetToken };
