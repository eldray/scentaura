'use strict';
/**
 * The ONLY place prices are worked out. The browser never sends a price;
 * it only sends variant ids, quantities, a delivery option and a coupon code.
 */

const MAX_QTY_PER_LINE = 20;

function effectivePrice(v) {
  return v.discount_price !== null && v.discount_price !== undefined && v.discount_price < v.price ? v.discount_price : v.price;
}

function priorOrderExists(db, email, phone) {
  const r = db.prepare(`SELECT 1 FROM orders
    WHERE (lower(customer_email) = lower(?) OR customer_phone = ?)
      AND status != 'cancelled' LIMIT 1`).get(email || '', phone || '');
  return !!r;
}

function normalizeItems(items) {
  const merged = new Map();
  for (const it of items || []) {
    const id = parseInt(it.variantId, 10);
    const qty = parseInt(it.qty, 10);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1) continue;
    merged.set(id, Math.min((merged.get(id) || 0) + qty, MAX_QTY_PER_LINE));
  }
  return [...merged.entries()].map(([variantId, qty]) => ({ variantId, qty }));
}

function loadLines(db, items) {
  const lines = [];
  const errors = [];
  const q = db.prepare(`SELECT v.*, p.name AS product_name, p.slug, p.status AS product_status, p.id AS pid,
      b.name AS brand_name, c.name AS category_name,
      (SELECT thumb_path FROM product_images i WHERE i.product_id = p.id ORDER BY i.sort, i.id LIMIT 1) AS thumb
    FROM product_variants v JOIN products p ON p.id = v.product_id
    LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN categories c ON c.id = p.category_id
    WHERE v.id = ?`);
  for (const it of normalizeItems(items)) {
    const v = q.get(it.variantId);
    if (!v || !v.active || v.product_status !== 'active') {
      errors.push({ variantId: it.variantId, message: 'An item in your cart is no longer available and was removed.', remove: true });
      continue;
    }
    const avail = Math.max(0, v.on_hand - v.reserved);
    const unit = effectivePrice(v);
    const line = {
      variantId: v.id, productId: v.pid, slug: v.slug, name: v.product_name, brand: v.brand_name || '', category: v.category_name || '',
      size: v.label, sku: v.sku, thumb: v.thumb, listPrice: v.price, unitPrice: unit, qty: it.qty, available: avail,
      lineTotal: unit * it.qty, onSale: unit < v.price
    };
    if (avail <= 0) {
      errors.push({ variantId: v.id, message: `${v.product_name} (${v.label}) is out of stock.`, remove: true });
      continue;
    }
    if (it.qty > avail) {
      errors.push({ variantId: v.id, message: `Only ${avail} of ${v.product_name} (${v.label}) left in stock.`, clampTo: avail });
      line.qty = avail; line.lineTotal = unit * avail; line.clamped = true;
    }
    lines.push(line);
  }
  return { lines, errors };
}

/** Returns { ok, coupon, discount, error } — never throws for a bad code. */
function validateCoupon(db, code, ctx) {
  const raw = String(code || '').trim();
  if (!raw) return { ok: false, discount: 0, error: null };
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const { subtotal, email, phone, customerId } = ctx;

  const c = db.prepare('SELECT * FROM coupons WHERE code = ? COLLATE NOCASE').get(raw);
  if (c) {
    if (!c.active) return { ok: false, discount: 0, error: 'This code is not active.' };
    if (c.starts_at && c.starts_at > now) return { ok: false, discount: 0, error: 'This code is not valid yet.' };
    if (c.expires_at && c.expires_at < now) return { ok: false, discount: 0, error: 'This code has expired.' };
    if (c.max_uses !== null && c.uses >= c.max_uses) return { ok: false, discount: 0, error: 'This code has been fully used.' };
    if (subtotal < c.min_spend) return { ok: false, discount: 0, error: `Spend at least ${(c.min_spend / 100).toFixed(2)} to use this code.`, minSpend: c.min_spend };
    if (c.first_order_only && (email || phone) && priorOrderExists(db, email, phone)) return { ok: false, discount: 0, error: 'This code is for first orders only.' };
    if (c.once_per_customer && (email || phone)) {
      const used = db.prepare(`SELECT 1 FROM coupon_redemptions r JOIN orders o ON o.id = r.order_id
        WHERE r.coupon_id = ? AND (lower(r.email) = lower(?) OR r.phone = ?) AND o.status != 'cancelled' LIMIT 1`).get(c.id, email || '', phone || '');
      if (used) return { ok: false, discount: 0, error: 'You have already used this code.' };
    }
    const discount = c.type === 'percent' ? Math.floor(subtotal * Math.min(c.value, 100) / 100) : Math.min(c.value, subtotal);
    return { ok: true, coupon: { id: c.id, code: c.code, type: c.type, value: c.value }, discount };
  }

  // Referral code: gives a first-time customer a percentage off (set in Settings).
  const ref = db.prepare('SELECT id, email FROM customers WHERE referral_code = ? COLLATE NOCASE').get(raw);
  const pct = parseInt(require('../lib/settings').get('referral_discount_percent', '0', db), 10) || 0;
  if (ref && pct > 0) {
    if ((customerId && customerId === ref.id) || (email && ref.email && ref.email.toLowerCase() === email.toLowerCase())) {
      return { ok: false, discount: 0, error: 'You cannot use your own referral code.' };
    }
    if ((email || phone) && priorOrderExists(db, email, phone)) return { ok: false, discount: 0, error: 'Referral codes are for first orders only.' };
    return { ok: true, referrerId: ref.id, coupon: { id: null, code: raw.toUpperCase(), type: 'percent', value: pct }, discount: Math.floor(subtotal * pct / 100) };
  }
  return { ok: false, discount: 0, error: 'That code is not valid.' };
}

function loadRate(db, rateId) {
  if (!rateId) return null;
  return db.prepare(`SELECT r.*, z.name AS zone_name, z.active AS zone_active FROM delivery_rates r
    JOIN delivery_zones z ON z.id = r.zone_id WHERE r.id = ?`).get(rateId) || null;
}

function priceCart(db, items, opts = {}) {
  const { lines, errors } = loadLines(db, items);
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);

  let discount = 0, coupon = null, couponError = null, referrerId = null;
  if (opts.couponCode) {
    const r = validateCoupon(db, opts.couponCode, { subtotal, email: opts.email, phone: opts.phone, customerId: opts.customerId });
    if (r.ok) { discount = Math.min(r.discount, subtotal); coupon = r.coupon; referrerId = r.referrerId || null; }
    else couponError = r.error;
  }
  const afterDiscount = subtotal - discount;

  let rate = null, deliveryFee = 0, rateError = null;
  if (opts.rateId) {
    rate = loadRate(db, opts.rateId);
    if (!rate || !rate.active || !rate.zone_active) { rate = null; rateError = 'That delivery option is not available.'; }
    else if (afterDiscount < rate.min_order) { rateError = `This delivery option needs an order of at least ${(rate.min_order / 100).toFixed(2)}.`; rate = null; }
    else if (rate.max_order !== null && afterDiscount > rate.max_order) { rateError = 'This delivery option is not available for an order this large.'; rate = null; }
    else deliveryFee = rate.free_over !== null && afterDiscount >= rate.free_over ? 0 : rate.fee;
  }

  return {
    lines, errors, subtotal, discount, coupon, couponError, referrerId,
    rate, rateError, deliveryFee, total: afterDiscount + deliveryFee,
    itemCount: lines.reduce((s, l) => s + l.qty, 0), ok: lines.length > 0 && errors.every(e => !e.remove || true)
  };
}

function availableRates(db) {
  return db.prepare(`SELECT r.*, z.name AS zone_name, z.sort AS zone_sort FROM delivery_rates r
    JOIN delivery_zones z ON z.id = r.zone_id WHERE r.active = 1 AND z.active = 1 ORDER BY z.sort, z.name, r.fee`).all();
}

module.exports = { effectivePrice, normalizeItems, priceCart, validateCoupon, availableRates, priorOrderExists, MAX_QTY_PER_LINE };
