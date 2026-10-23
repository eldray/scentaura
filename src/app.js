'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const dbm = require('./db');
const settings = require('./lib/settings');
const util = require('./lib/util');
const infra = require('./lib/infra');
const payments = require('./services/payments');
const momo = require('./services/momo');

function createApp(db = dbm.get()) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.root, 'views'));
  app.disable('x-powered-by');
  if (config.isProd) app.set('trust proxy', 1);
  app.locals.db = db;
  infra.useDb(db);

  /* ----- Paystack webhook: needs the raw body, no session, no CSRF ----- */
  app.post('/webhooks/paystack', express.raw({ type: '*/*', limit: '200kb' }), (req, res) => {
    try {
      const out = payments.handleWebhook(db, req.body, req.get('x-paystack-signature'));
      res.status(out.status).send(out.body);
    } catch (e) {
      console.error('webhook error', e);
      res.status(500).send('error');     // Paystack will retry
    }
  });

  /* ----- MTN MoMo callback: unsigned, so it only triggers a fresh status check with MTN ----- */
  app.all('/webhooks/momo/:reference', express.raw({ type: '*/*', limit: '50kb' }), async (req, res) => {
    try {
      const out = await momo.handleCallback(db, req.params.reference);
      res.status(out.status).send(out.body);
    } catch (e) {
      console.error('momo callback error', e.message);
      res.status(500).send('error');
    }
  });

  /* ----- security headers ----- */
  app.use((req, res, next) => {
    const s = settings.all(db);
    const script = ["'self'"], connect = ["'self'"], frame = ["'self'"];
    if (s.plausible_domain) { script.push('https://plausible.io'); connect.push('https://plausible.io'); }
    if (s.ga_measurement_id) { script.push('https://www.googletagmanager.com'); connect.push('https://www.google-analytics.com', 'https://*.google-analytics.com', 'https://www.googletagmanager.com'); }
    if (s.map_embed_url) frame.push('https://www.google.com', 'https://maps.google.com');
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"], scriptSrc: script, styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https://www.google-analytics.com', 'https://images.unsplash.com'], connectSrc: connect, frameSrc: frame,
          objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'self'"],
          formAction: ["'self'", 'https://checkout.paystack.com', 'https://*.paystack.com']
        }
      },
      crossOriginEmbedderPolicy: false,
      hsts: config.isProd ? undefined : false
    })(req, res, next);
  });

  app.use('/public', express.static(path.join(config.root, 'public'), { maxAge: config.isProd ? '7d' : 0 }));
  app.use('/uploads', express.static(config.uploadDir, { maxAge: config.isProd ? '30d' : 0, setHeaders: r => r.setHeader('X-Content-Type-Options', 'nosniff') }));

  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(express.json({ limit: '100kb' }));

  const store = new infra.SqliteStore(db);
  app.use(session({
    name: 'sa.sid',
    secret: config.sessionSecret || 'dev-only-secret-change-me-dev-only-secret',
    resave: false, saveUninitialized: false, store,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 7 * 24 * 3600 * 1000 }
  }));
  app.set('sessionStore', store);

  app.use(infra.csrf);

  /* ----- shared template data + helpers ----- */
  app.use((req, res, next) => {
    const s = settings.all(db);
    const cart = Array.isArray(req.session.cart) ? req.session.cart : [];
    req.customer = req.session.customerId ? db.prepare('SELECT id, name, email, phone, referral_code, marketing_consent FROM customers WHERE id = ?').get(req.session.customerId) : null;
    Object.assign(res.locals, {
      S: s, f: require('./lib/forms'), ghs: v => util.ghs(v, s.currency_symbol || 'GHS'), fromPesewas: util.fromPesewas, paragraphs: util.paragraphs,
      ORDER_STATUSES: util.ORDER_STATUSES, GH_REGIONS: util.GH_REGIONS,
      wishIds: new Set(req.customer ? db.prepare('SELECT product_id FROM wishlists WHERE customer_id = ?').all(req.customer.id).map(r => r.product_id) : []),
      customer: req.customer, cartCount: cart.reduce((n, i) => n + (i.qty || 0), 0), flash: req.session.flash || null,
      baseUrl: config.baseUrl, currentPath: req.path, query: req.query,
      title: '', description: '', canonical: null, ogImage: null, jsonld: null, noindex: false, isAdmin: false,
      waLink: (text) => {
        const n = String(s.whatsapp_number || '').replace(/\D/g, '');
        return n ? `https://wa.me/${n}?text=${encodeURIComponent(text || `Hello ${s.business_name}, I have a question.`)}` : null;
      }
    });
    delete req.session.flash;
    res.flash = (type, msg) => { req.session.flash = { type, msg }; };
    res.admin = (view, locals = {}) => {
      const staff = req.staff;
      app.render('admin/' + view, { ...res.locals, isAdmin: true, staff, ROLE_LABELS: infra.ROLE_LABELS, ...locals }, (err, body) => {
        if (err) return next(err);
        res.render('admin/layout', { isAdmin: true, staff, can: p => infra.can(staff && staff.role, p), ROLE_LABELS: infra.ROLE_LABELS, pageTitle: locals.pageTitle || '', ...locals, body });
      });
    };
    res.page = (view, locals = {}) => {
      app.render(view, { ...res.locals, ...locals }, (err, body) => {
        if (err) return next(err);
        res.render('layout', { ...locals, body });
      });
    };
    next();
  });

  /* ----- rate limits ----- */
  const limit = (windowMin, max, msg) => rateLimit({
    windowMs: windowMin * 60 * 1000, limit: max, standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => res.status(429).render('fatal', { title: 'Slow down', message: msg || 'Too many attempts. Please wait a few minutes and try again.', layout: false })
  });
  app.use(rateLimit({ windowMs: 60 * 1000, limit: config.isProd ? 300 : 5000, standardHeaders: true, legacyHeaders: false }));
  app.locals.limiters = { auth: limit(15, config.isProd ? 10 : 1000), reset: limit(60, config.isProd ? 5 : 1000), track: limit(10, config.isProd ? 20 : 1000), checkout: limit(10, config.isProd ? 30 : 1000), coupon: limit(10, config.isProd ? 30 : 1000) };

  /* ----- routes ----- */
  app.use(require('./routes/seo'));
  app.use(require('./routes/shop'));
  app.use(require('./routes/cart'));
  app.use(require('./routes/checkout'));
  app.use(require('./routes/account'));
  app.use(require('./routes/content'));
  app.use('/admin', require('./routes/admin'));

  app.use((req, res) => res.status(404).page('error', { title: 'Page not found', message: 'We could not find that page.', noindex: true }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).send('Request too large');
    console.error(err);
    const msg = config.isProd ? 'Something went wrong on our side. Please try again.' : String(err && err.message);
    if (res.headersSent) return;
    res.status(err && err.status ? err.status : 500).render('fatal', { title: 'Error', message: msg, layout: false });
  });

  return app;
}

module.exports = { createApp };
