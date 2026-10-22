'use strict';
process.env.NODE_ENV = 'test';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_unit_secret';
const crypto = require('crypto');
const dbm = require('../src/db');
const catalog = require('../src/services/catalog');
const inventory = require('../src/services/inventory');
const orders = require('../src/services/orders');
const payments = require('../src/services/payments');
const settings = require('../src/lib/settings');

function freshDb() {
  const db = dbm.memory();
  settings.invalidate();
  return db;
}

/** One product, sizes: [label, price, cost, qty, discount?] */
function addProduct(db, name, variants, opts = {}) {
  const brandId = catalog.upsertBrand(db, opts.brand || 'Test Brand');
  const pid = Number(db.prepare("INSERT INTO products (slug, name, brand_id, category_id, audience, status) VALUES (?,?,?,(SELECT id FROM categories LIMIT 1),'unisex',?)")
    .run(catalog.uniqueSlug(db, name), name, brandId, opts.status || 'active').lastInsertRowid);
  return variants.map(([label, price, cost, qty, discount]) => {
    const vid = Number(db.prepare('INSERT INTO product_variants (product_id, size_ml, label, sku, price, discount_price, cost) VALUES (?,?,?,?,?,?,?)')
      .run(pid, parseInt(label, 10) || 0, label, `${name}-${label}`.toUpperCase().replace(/\s/g, ''), price, discount || null, cost).lastInsertRowid);
    if (qty) inventory.move(db, vid, { type: 'opening', onHandChange: qty, unitCost: cost, reason: 'test' });
    return vid;
  });
}

function addRate(db, o = {}) {
  const zone = db.prepare('SELECT id, name FROM delivery_zones ORDER BY id LIMIT 1').get();
  const id = Number(db.prepare('INSERT INTO delivery_rates (zone_id, method, name, fee, free_over, min_order, max_order, eta_text) VALUES (?,?,?,?,?,?,?,?)')
    .run(zone.id, o.method || 'standard', o.name || 'Standard', o.fee === undefined ? 3000 : o.fee, o.freeOver === undefined ? null : o.freeOver, o.min || 0, o.max === undefined ? null : o.max, '1 day').lastInsertRowid);
  return id;
}

function order(db, items, o = {}) {
  return orders.createOrder(db, {
    name: 'Ama Mensah', email: 'ama@example.com', phone: o.phone || '0241234567', line1: '12 Test Street', town: 'Accra', region: 'Greater Accra',
    paymentMethod: o.paymentMethod || 'paystack', rateId: o.rateId, couponCode: o.couponCode, items: items.map(([variantId, qty]) => ({ variantId, qty })), ...o.extra
  });
}

function sign(body) { return crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(body).digest('hex'); }

function chargeEvent(reference, amount, extra = {}) {
  return JSON.stringify({ event: 'charge.success', data: { id: extra.id || 987654, reference, amount, currency: extra.currency || 'GHS', status: 'success', channel: 'mobile_money', fees: 150, paid_at: new Date().toISOString() } });
}

function webhook(db, body, signature) {
  const raw = Buffer.from(body);
  return payments.handleWebhook(db, raw, signature === undefined ? sign(raw) : signature);
}

function stock(db, variantId) { return db.prepare('SELECT on_hand, reserved FROM product_variants WHERE id = ?').get(variantId); }

module.exports = { freshDb, addProduct, addRate, order, sign, chargeEvent, webhook, stock, payments, orders, inventory, settings };
