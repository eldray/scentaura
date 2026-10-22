'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-up-'));
const bcrypt = require('bcryptjs');
const h = require('./helpers');
const { createApp } = require('../src/app');

class Client {
  constructor(base) { this.base = base; this.cookies = {}; }
  async req(method, url, { form, headers, body, raw } = {}) {
    const h2 = { ...(headers || {}) };
    if (Object.keys(this.cookies).length) h2.cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    let b = body;
    if (form) { h2['content-type'] = 'application/x-www-form-urlencoded'; b = new URLSearchParams(form).toString(); }
    const r = await fetch(this.base + url, { method, headers: h2, body: b, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) delete this.cookies[k]; else this.cookies[k] = v; }
    const text = raw ? '' : await r.text();
    return { status: r.status, text, location: r.headers.get('location'), headers: r.headers };
  }
  get(u) { return this.req('GET', u); }
  async csrf(url) { const r = await this.get(url); const m = /name="_csrf" value="([^"]+)"/.exec(r.text); assert.ok(m, 'no csrf token on ' + url); return m[1]; }
  async post(u, form, tokenFrom) { const t = await this.csrf(tokenFrom || u); return this.req('POST', u, { form: { _csrf: t, ...form } }); }
}

async function boot() {
  const db = h.freshDb();
  const [a, b] = [...h.addProduct(db, 'Noir', [['50 ml', 38000, 15000, 5]], { brand: 'Maison' }), ...h.addProduct(db, 'Oud', [['100 ml', 90000, 40000, 0]])];
  const rate = h.addRate(db, { fee: 3000 });
  const mk = (email, role) => db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)').run(email, role, bcrypt.hashSync('correct horse battery', 4), role);
  ['owner', 'manager', 'sales', 'inventory'].forEach(r => mk(`${r}@shop.test`, r));
  const app = createApp(db);
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  return { db, a, b, rate, server, base: `http://127.0.0.1:${server.address().port}`, app };
}

test('public pages render', async () => {
  const { server, base } = await boot();
  try {
    const c = new Client(base);
    for (const p of ['/', '/shop', '/men', '/women', '/unisex', '/oils-body-sprays', '/new-arrivals', '/best-sellers', '/offers', '/search?q=noir', '/about', '/contact', '/faq', '/delivery-returns', '/authenticity', '/privacy', '/terms', '/blog', '/blog/how-to-choose-a-perfume', '/track', '/cart', '/login', '/register', '/forgot', '/sitemap.xml', '/robots.txt']) {
      const r = await c.get(p); assert.equal(r.status, 200, p);
    }
    const prod = await c.get('/shop'); assert.match(prod.text, /Noir/);
    assert.equal((await c.get('/product/nothing-here')).status, 404);
    const pr = await c.get('/product/noir'); assert.equal(pr.status, 200); assert.match(pr.text, /application\/ld\+json/); assert.match(pr.text, /GHS 380\.00/);
    assert.match((await c.get('/sitemap.xml')).text, /noir/);
    assert.equal((await c.get('/shop?sort=price_asc&min=100&max=500&brand=maison&inStock=1')).status, 200);
    assert.equal((await c.get('/shop?min=abc&page=-4&perPage=9999')).status, 200);
  } finally { server.close(); }
});

test('full guest journey: cart → checkout → order → webhook → paid → dispatch → track', async () => {
  const { db, server, base, a, rate } = await boot();
  try {
    h.payments.client.request = async () => ({ data: { authorization_url: 'https://checkout.paystack.com/test', status: 'success' } });
    const c = new Client(base);
    let r = await c.post('/cart/add', { variantId: a, qty: 2, back: '/shop' }, '/product/noir');
    assert.equal(r.status, 302);
    assert.match((await c.get('/cart')).text, /GHS 760\.00/);
    // review step: browser-sent prices are ignored, bad phone is rejected
    const bad = await c.post('/checkout/review', { name: 'Ama', email: 'ama@example.com', phone: '123', rateId: rate, line1: '1 Road', town: 'Accra', region: 'Greater Accra', paymentMethod: 'paystack', total: '1' }, '/checkout');
    assert.match(bad.text, /valid Ghana phone/);
    const ok = await c.post('/checkout/review', { name: 'Ama', email: 'ama@example.com', phone: '024 123 4567', rateId: rate, line1: '1 Road', town: 'Accra', region: 'Greater Accra', paymentMethod: 'paystack', total: '1' }, '/checkout');
    assert.equal(ok.status, 200); assert.match(ok.text, /GHS 790\.00/);
    const conf = await c.post('/checkout/confirm', {}, '/checkout');
    assert.equal(conf.status, 303); assert.equal(conf.location, 'https://checkout.paystack.com/test');
    const o = db.prepare('SELECT * FROM orders').get();
    assert.equal(o.total, 76000 + 3000); assert.equal(o.customer_phone, '+233241234567'); assert.equal(o.payment_status, 'pending');
    // coming back to the success page does NOT mark it paid
    h.payments.client.request = async () => ({ data: { status: 'abandoned' } });
    const pay = db.prepare('SELECT reference FROM payments').get();
    await c.get(`/payment/callback?reference=${pay.reference}`);
    assert.notEqual(db.prepare('SELECT payment_status FROM orders').get().payment_status, 'paid');
    // only the signed webhook does
    const body = h.chargeEvent(pay.reference, o.total);
    const wh = await c.req('POST', '/webhooks/paystack', { body, headers: { 'x-paystack-signature': h.sign(Buffer.from(body)), 'content-type': 'application/json' } });
    assert.equal(wh.status, 200);
    assert.equal(db.prepare('SELECT payment_status FROM orders').get().payment_status, 'paid');
    const bad2 = await c.req('POST', '/webhooks/paystack', { body, headers: { 'x-paystack-signature': 'nope', 'content-type': 'application/json' } });
    assert.equal(bad2.status, 401);
    // the customer can see the order via the secret link, not by guessing the number
    assert.equal((await c.get(`/order/${o.order_no}`)).status, 404);
    const page = await c.get(`/order/${o.order_no}?t=${o.tracking_token}`); assert.equal(page.status, 200); assert.match(page.text, /Payment received/);
    // track form: wrong contact fails, right one redirects
    const t1 = await c.post('/track', { orderNo: o.order_no, contact: 'someone@else.com' }); assert.equal(t1.status, 404);
    const t2 = await c.post('/track', { orderNo: o.order_no, contact: '0241234567' }); assert.equal(t2.status, 302);
  } finally { server.close(); }
});

test('out-of-stock and sold-out items cannot be bought', async () => {
  const { server, base, b } = await boot();
  try {
    const c = new Client(base);
    await c.post('/cart/add', { variantId: b, qty: 1 }, '/track');
    assert.match((await c.get('/cart')).text, /empty/i);
    assert.match((await c.get('/product/oud')).text, /sold out/i);
  } finally { server.close(); }
});

test('forms without a valid CSRF token are refused', async () => {
  const { server, base, a } = await boot();
  try {
    const c = new Client(base);
    assert.equal((await c.req('POST', '/cart/add', { form: { variantId: a, qty: 1 } })).status, 403);
    await c.get('/cart');
    assert.equal((await c.req('POST', '/cart/add', { form: { variantId: a, qty: 1, _csrf: 'wrong' } })).status, 403);
    assert.equal((await c.req('POST', '/admin/login', { form: { email: 'owner@shop.test', password: 'x' } })).status, 403);
  } finally { server.close(); }
});

test('customer registration, login, wrong password, logout', async () => {
  const { server, base } = await boot();
  try {
    const c = new Client(base);
    let r = await c.post('/register', { name: 'Kofi Boateng', email: 'kofi@example.com', phone: '0551234567', password: 'password123', password2: 'password123' });
    assert.equal(r.status, 302); assert.equal(r.location, '/account');
    assert.match((await c.get('/account')).text, /My account/);
    await c.post('/logout', {}, '/account'); assert.equal((await c.get('/account')).status, 302);
    const bad = await c.post('/login', { email: 'kofi@example.com', password: 'wrong' }); assert.equal(bad.status, 401);
    const good = await c.post('/login', { email: 'kofi@example.com', password: 'password123' }); assert.equal(good.status, 302);
    const short = await new Client(base).post('/register', { name: 'X Y', email: 'a@b.co', password: 'short', password2: 'short' }); assert.equal(short.status, 400);
    const dup = await new Client(base).post('/register', { name: 'Kofi B', email: 'KOFI@example.com', password: 'password123', password2: 'password123' }); assert.equal(dup.status, 400);
  } finally { server.close(); }
});

async function staff(base, role) {
  const c = new Client(base);
  const r = await c.post('/admin/login', { email: `${role}@shop.test`, password: 'correct horse battery' }, '/admin/login');
  assert.equal(r.status, 302, `${role} login`);
  return c;
}

test('admin pages need a login; wrong passwords are refused', async () => {
  const { server, base } = await boot();
  try {
    const c = new Client(base);
    for (const p of ['/admin', '/admin/orders', '/admin/products', '/admin/settings', '/admin/users', '/admin/reports']) { const r = await c.get(p); assert.equal(r.status, 302, p); assert.equal(r.location, '/admin/login'); }
    const bad = await c.post('/admin/login', { email: 'owner@shop.test', password: 'nope' }, '/admin/login'); assert.equal(bad.status, 401);
    assert.match(bad.headers.get('cache-control') || '', /no-store/);
  } finally { server.close(); }
});

test('role permissions are enforced on the backend (GET and POST)', async () => {
  const { server, base, db } = await boot();
  try {
    const expect = {
      owner: { allow: ['/admin', '/admin/orders', '/admin/products', '/admin/inventory', '/admin/suppliers', '/admin/reports', '/admin/expenses', '/admin/settings', '/admin/users', '/admin/payments', '/admin/customers', '/admin/promotions', '/admin/deliveries', '/admin/content/pages', '/admin/account', '/admin/help', '/admin/content/blog', '/admin/content/faqs', '/admin/content/reviews'], deny: [] },
      manager: { allow: ['/admin', '/admin/orders', '/admin/products', '/admin/reports', '/admin/payments'], deny: ['/admin/settings', '/admin/users'] },
      sales: { allow: ['/admin', '/admin/orders', '/admin/customers', '/admin/deliveries'], deny: ['/admin/products', '/admin/inventory', '/admin/reports', '/admin/expenses', '/admin/payments', '/admin/settings', '/admin/users', '/admin/suppliers', '/admin/promotions'] },
      inventory: { allow: ['/admin', '/admin/products', '/admin/inventory', '/admin/suppliers'], deny: ['/admin/orders', '/admin/reports', '/admin/customers', '/admin/payments', '/admin/settings', '/admin/users', '/admin/expenses'] }
    };
    for (const [role, e] of Object.entries(expect)) {
      const c = await staff(base, role);
      for (const p of e.allow) assert.equal((await c.get(p)).status, 200, `${role} should open ${p}`);
      for (const p of e.deny) assert.equal((await c.get(p)).status, 403, `${role} must NOT open ${p}`);
    }
    // a sales user cannot change stock, create staff, or refund by posting directly
    const sales = await staff(base, 'sales');
    const tok = await sales.csrf('/admin/orders');
    for (const [u, f] of [['/admin/inventory/adjust', { variantId: 1, qty: 5, reason: 'hack' }], ['/admin/users', { name: 'x', email: 'x@y.com', password: 'longpassword1', role: 'owner' }], ['/admin/settings', { business_name: 'Hacked' }], ['/admin/expenses', { amount: '5' }]]) {
      assert.equal((await sales.req('POST', u, { form: { _csrf: tok, ...f } })).status, 403, u);
    }
    assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE email = 'x@y.com'").get().c, 0);
    assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('business_name').value, 'ScentAura');
  } finally { server.close(); }
});

test('owner can add a product with a size, upload a real image, and reject a fake one', async () => {
  const { server, base, db } = await boot();
  try {
    const c = await staff(base, 'owner');
    let r = await c.post('/admin/products/new', { name: 'Rose Garden', brand: 'Atelier', audience: 'women', status: 'active', concentration: 'Eau de Parfum', category_id: 1 }, '/admin/products/new');
    assert.equal(r.status, 302);
    const pid = db.prepare("SELECT id FROM products WHERE name = 'Rose Garden'").get().id;
    r = await c.post(`/admin/products/${pid}/variants`, { size_ml: 50, price: '450.00', cost: '200', opening_qty: 12 }, `/admin/products/${pid}/edit`);
    const v = db.prepare('SELECT * FROM product_variants WHERE product_id = ?').get(pid);
    assert.equal(v.price, 45000); assert.equal(v.on_hand, 12); assert.equal(v.cost, 20000);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_movements WHERE variant_id = ? AND type = 'opening'").get(v.id).c, 1);
    r = await c.post(`/admin/products/${pid}`, { name: 'Rose Garden', brand: 'Atelier', audience: 'women', status: 'active' }, `/admin/products/${pid}/edit`);
    assert.equal(db.prepare('SELECT status FROM products WHERE id = ?').get(pid).status, 'active');
    // discount must be below price
    await c.post(`/admin/products/${pid}/variants/${v.id}`, { size_ml: 50, price: '450', discount_price: '500', cost: '200', low_stock_threshold: 5, active: 1 }, `/admin/products/${pid}/edit`);
    assert.equal(db.prepare('SELECT discount_price FROM product_variants WHERE id = ?').get(v.id).discount_price, null);
    // image upload (multipart): a real PNG works, a text file renamed .png does not
    const sharp = require('sharp');
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#b8975a' } }).png().toBuffer();
    const tok = await c.csrf(`/admin/products/${pid}/edit`);
    const send = async (buf, type, name) => { const fd = new FormData(); fd.append('images', new Blob([buf], { type }), name); fd.append('alt', 'Bottle'); return c.req('POST', `/admin/products/${pid}/images?_csrf=${tok}`, { body: fd }); };
    await send(png, 'image/png', 'bottle.png');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM product_images WHERE product_id = ?').get(pid).c, 1);
    const img = db.prepare('SELECT * FROM product_images WHERE product_id = ?').get(pid);
    assert.match(img.path, /^\/uploads\/products\/[a-f0-9]+\.webp$/);
    assert.equal((await c.get(img.path)).status, 200);
    await send(Buffer.from('<script>alert(1)</script>'), 'image/png', 'evil.png');
    await send(png, 'text/html', 'x.html');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM product_images WHERE product_id = ?').get(pid).c, 1);
    // it shows up in the shop
    assert.match((await new Client(base).get('/product/atelier-rose-garden')).text, /uploads\/products/);
    // audit log recorded the actions
    assert.ok(db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action = 'product_created'").get().c >= 1);
  } finally { server.close(); }
});

test('owner runs an order through the admin: dispatch, cod cash, refund, staff-only actions', async () => {
  const { server, base, db, a, rate } = await boot();
  try {
    db.prepare("UPDATE settings SET value = '1' WHERE key = 'cod_enabled'").run(); h.settings.invalidate();
    const o = h.order(db, [[a, 1]], { rateId: rate, paymentMethod: 'cod' });
    const c = await staff(base, 'owner');
    const page = await c.get(`/admin/orders/${o.id}`); assert.equal(page.status, 200); assert.match(page.text, /Record cash collected/);
    assert.equal((await c.get(`/admin/orders/${o.id}/print`)).status, 200);
    let r = await c.post(`/admin/orders/${o.id}/status`, { status: 'dispatched' }, `/admin/orders/${o.id}`);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(o.id).status, 'dispatched');
    await c.post(`/admin/orders/${o.id}/status`, { status: 'delivered' }, `/admin/orders/${o.id}`);
    await c.post(`/admin/orders/${o.id}/collect-cod`, {}, `/admin/orders/${o.id}`);
    assert.equal(db.prepare('SELECT payment_status FROM orders WHERE id = ?').get(o.id).payment_status, 'paid');
    r = await c.post(`/admin/orders/${o.id}/refund`, { amount: '50.00', reason: 'Goodwill', method: 'manual' }, `/admin/orders/${o.id}`);
    assert.equal(db.prepare('SELECT payment_status FROM orders WHERE id = ?').get(o.id).payment_status, 'partially_refunded');
    // invalid transition refused
    await c.post(`/admin/orders/${o.id}/status`, { status: 'processing' }, `/admin/orders/${o.id}`);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(o.id).status, 'delivered');
    for (const p of ['/admin/reports', '/admin/payments', '/admin/orders?format=csv', '/admin/reports/export/profit', '/admin/reports/export/stock', '/admin/inventory/movements?format=csv', '/admin/customers/marketing-list.csv', '/admin/settings/audit']) {
      assert.equal((await c.get(p)).status, 200, p);
    }
  } finally { server.close(); }
});

test('security headers, no stack traces, no admin indexing', async () => {
  const { server, base } = await boot();
  try {
    const c = new Client(base);
    const r = await c.get('/');
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.match((await c.get('/robots.txt')).text, /Disallow: \/admin/);
    assert.match((await c.get('/admin/login')).headers.get('x-robots-tag'), /noindex/);
    const nf = await c.get('/does/not/exist'); assert.equal(nf.status, 404); assert.ok(!/node_modules|at Object/.test(nf.text));
  } finally { server.close(); }
});
