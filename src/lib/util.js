'use strict';
const crypto = require('crypto');

/* ---------- money (all amounts are integer pesewas) ---------- */
function ghs(pesewas, symbol = 'GHS') {
  const n = Math.round(Number(pesewas) || 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${symbol} ${whole}.${cents}`;
}

/** "1,450.50" or "1450" -> 145050. Returns null if not a valid non-negative amount. */
function toPesewas(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).replace(/[,\s]/g, '').replace(/^GHS/i, '');
  if (s === '' || !/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

function fromPesewas(p) {
  if (p === null || p === undefined || p === '') return '';
  return (Number(p) / 100).toFixed(2);
}

/* ---------- phone numbers (Ghana) ---------- */
/**
 * Accepts 024 123 4567, 0241234567, 233241234567, +233 24 123 4567.
 * Returns +233XXXXXXXXX or null.
 */
function normalizeGhPhone(input) {
  if (!input) return null;
  const s = String(input).replace(/[\s\-().]/g, '');
  const m = /^(?:\+233|00233|233|0)([235]\d{8})$/.exec(s);
  return m ? '+233' + m[1] : null;
}

function isEmail(s) {
  return typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

/* ---------- random / ids ---------- */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alike characters
function randomCode(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function orderNumber(date = new Date()) {
  const y = String(date.getUTCFullYear()).slice(2);
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `SA-${y}${m}${d}-${randomCode(5)}`;
}

function token(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ---------- text ---------- */
function slugify(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function clean(s, max = 500) {
  return String(s === undefined || s === null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function int(v, def = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function paragraphs(text) {
  return String(text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
}

function nowSql() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }

const GH_REGIONS = ['Greater Accra', 'Ashanti', 'Western', 'Western North', 'Central', 'Eastern', 'Volta', 'Oti', 'Northern', 'Savannah', 'North East', 'Upper East', 'Upper West', 'Bono', 'Bono East', 'Ahafo'];

const ORDER_STATUSES = {
  pending_confirmation: 'Pending confirmation',
  payment_pending: 'Payment pending',
  paid: 'Paid',
  processing: 'Processing',
  packed: 'Packed',
  dispatched: 'Dispatched',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  return_requested: 'Return requested',
  returned: 'Returned',
  refunded: 'Refunded'
};

module.exports = { ghs, toPesewas, fromPesewas, normalizeGhPhone, isEmail, randomCode, orderNumber, token, sha256, safeEqual, slugify, clean, int, paragraphs, nowSql, GH_REGIONS, ORDER_STATUSES };
