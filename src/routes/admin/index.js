'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../../config');
const util = require('../../lib/util');
const infra = require('../../lib/infra');
const reports = require('../../services/reports');
const inventory = require('../../services/inventory');
const router = express.Router();

const db = req => req.app.locals.db;
const lim = name => (req, res, next) => req.app.locals.limiters[name](req, res, next);
const IDLE_MS = 2 * 60 * 60 * 1000;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

/* Never cache or index anything under /admin */
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.locals.noindex = true;
  next();
});

/* Load the signed-in staff member (and sign them out after 2 idle hours). */
router.use((req, res, next) => {
  const id = req.session.staffId;
  if (id) {
    const idle = Date.now() - (req.session.staffSeen || 0);
    const u = idle > IDLE_MS ? null : db(req).prepare('SELECT id, email, name, role FROM users WHERE id = ? AND active = 1').get(id);
    if (u) { req.staff = u; req.session.staffSeen = Date.now(); }
    else { delete req.session.staffId; delete req.session.staffSeen; }
  }
  next();
});

/** Backend permission check. Hiding a button is never the only protection. */
function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.staff) { req.session.adminReturn = req.originalUrl; return res.redirect('/admin/login'); }
    if (!infra.can(req.staff.role, perm)) return res.status(403).admin('forbidden', { pageTitle: 'Not allowed' });
    next();
  };
}
const requireStaff = (req, res, next) => (req.staff ? next() : (req.session.adminReturn = req.originalUrl, res.redirect('/admin/login')));
router.requirePerm = requirePerm;

function startStaffSession(req, user, cb) {
  req.session.regenerate(err => {
    if (err) return cb(err);
    req.session.staffId = user.id;
    req.session.staffSeen = Date.now();
    cb(null);
  });
}

/* ---------- login / logout ---------- */
router.get('/login', (req, res) => {
  if (req.staff) return res.redirect('/admin');
  const firstRun = db(req).prepare('SELECT COUNT(*) c FROM users').get().c === 0;
  res.admin('login', { pageTitle: 'Staff sign in', bare: true, error: null, firstRun, setupEnabled: !!config.adminSetupToken });
});

router.post('/login', lim('auth'), (req, res) => {
  const email = util.clean(req.body.email, 254).toLowerCase();
  const u = db(req).prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE AND active = 1').get(email);
  const ok = bcrypt.compareSync(String(req.body.password || ''), u ? u.password_hash : DUMMY_HASH) && !!u;
  if (!ok) {
    infra.audit({ ip: req.ip }, 'login_failed', 'user', null, email);
    return res.status(401).admin('login', { pageTitle: 'Staff sign in', bare: true, error: 'Incorrect email or password.', firstRun: false, setupEnabled: false });
  }
  const ret = req.session.adminReturn;
  startStaffSession(req, u, err => {
    if (err) throw err;
    db(req).prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(u.id);
    req.staff = u;
    infra.audit(req, 'login', 'user', u.id);
    res.redirect(typeof ret === 'string' && ret.startsWith('/admin') ? ret : '/admin');
  });
});

router.post('/logout', (req, res) => {
  if (req.staff) infra.audit(req, 'logout', 'user', req.staff.id);
  req.session.destroy(() => { res.clearCookie('sa.sid'); res.redirect('/admin/login'); });
});

/* ---------- one-time creation of the first owner ----------
   Only works while there are NO users and ADMIN_SETUP_TOKEN is set in the environment.
   The CLI command `npm run create-admin` is the other (preferred) way. */
router.get('/setup', (req, res) => {
  const none = db(req).prepare('SELECT COUNT(*) c FROM users').get().c === 0;
  if (!none || !config.adminSetupToken) return res.redirect('/admin/login');
  res.admin('setup', { pageTitle: 'Create the owner account', bare: true, errors: [] });
});

router.post('/setup', lim('auth'), (req, res) => {
  const d = db(req);
  const none = d.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
  if (!none || !config.adminSetupToken) return res.redirect('/admin/login');
  const errors = [];
  if (!util.safeEqual(String(req.body.token || ''), config.adminSetupToken)) errors.push('The setup token is not correct.');
  const email = util.clean(req.body.email, 254).toLowerCase(), name = util.clean(req.body.name, 100);
  if (!util.isEmail(email)) errors.push('Enter a valid email address.');
  if (name.length < 2) errors.push('Enter your name.');
  if (!req.body.password || req.body.password.length < 10) errors.push('Choose a password of at least 10 characters.');
  if (req.body.password !== req.body.password2) errors.push('The passwords do not match.');
  if (errors.length) return res.status(400).admin('setup', { pageTitle: 'Create the owner account', bare: true, errors });
  const id = Number(d.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?, 'owner')").run(email, name, bcrypt.hashSync(req.body.password, 12)).lastInsertRowid);
  infra.audit({ ip: req.ip, staff: { id, name, email } }, 'owner_created', 'user', id, 'via setup page');
  res.flash('success', 'Owner account created. Remove ADMIN_SETUP_TOKEN from your settings now, then sign in.');
  res.redirect('/admin/login');
});

/* ---------- staff password reset by email ---------- */
router.get('/forgot', (req, res) => res.admin('forgot', { pageTitle: 'Reset password', bare: true, sent: false }));
router.post('/forgot', lim('reset'), (req, res) => {
  const d = db(req);
  const u = d.prepare('SELECT id, name, email FROM users WHERE email = ? COLLATE NOCASE AND active = 1').get(util.clean(req.body.email, 254));
  if (u) {
    const t = util.token(32);
    d.prepare("UPDATE users SET reset_token_hash = ?, reset_expires = datetime('now','+1 hour') WHERE id = ?").run(util.sha256(t), u.id);
    infra.sendMail(u.email, 'Staff password reset', `Hello ${u.name},\n\nUse this link within one hour:\n${config.baseUrl}/admin/reset/${t}\n\nIf you did not ask for this, ignore this email.`, d).catch(() => {});
  }
  res.admin('forgot', { pageTitle: 'Reset password', bare: true, sent: true });
});
const findStaffReset = (d, t) => d.prepare("SELECT id FROM users WHERE reset_token_hash = ? AND reset_expires > datetime('now')").get(util.sha256(String(t)));
router.get('/reset/:token', (req, res) => res.admin('reset', { pageTitle: 'New password', bare: true, valid: !!findStaffReset(db(req), req.params.token), token: req.params.token, error: null }));
router.post('/reset/:token', lim('reset'), (req, res) => {
  const d = db(req), u = findStaffReset(d, req.params.token);
  if (!u) return res.status(400).admin('reset', { pageTitle: 'New password', bare: true, valid: false, token: '', error: null });
  if (!req.body.password || req.body.password.length < 10 || req.body.password !== req.body.password2) {
    return res.status(400).admin('reset', { pageTitle: 'New password', bare: true, valid: true, token: req.params.token, error: 'Passwords must match and be at least 10 characters.' });
  }
  d.prepare('UPDATE users SET password_hash = ?, reset_token_hash = NULL, reset_expires = NULL WHERE id = ?').run(bcrypt.hashSync(req.body.password, 12), u.id);
  infra.audit({ ip: req.ip }, 'staff_password_reset', 'user', u.id);
  res.flash('success', 'Password changed. Please sign in.');
  res.redirect('/admin/login');
});

/* ---------- everything below needs a signed-in staff member ---------- */
router.use(requireStaff);

router.get('/', requirePerm('dashboard'), (req, res) => {
  const d = db(req);
  const data = reports.dashboard(d);
  const r = reports.range();
  const prof = infra.can(req.staff.role, 'reports') ? reports.profit(d, r.from, r.to) : null;
  const month = new Date().toISOString().slice(0, 7) + '-01';
  const rng = infra.can(req.staff.role, 'reports') ? {
    best: reports.productRevenue(d, month, r.to).slice(0, 5), byCategory: reports.categoryRevenue(d, month, r.to), methods: reports.paymentBreakdown(d, month, r.to), profit: reports.profit(d, month, r.to)
  } : null;
  const S = res.locals.S;
  const checklist = [
    ['Add your business details (phone, email, WhatsApp)', !!(S.contact_phone && S.contact_email), '/admin/settings'],
    ['Set up delivery fees', d.prepare('SELECT COUNT(*) c FROM delivery_rates WHERE active = 1').get().c > 0, '/admin/deliveries'],
    ['Add at least one product', d.prepare("SELECT COUNT(*) c FROM products WHERE status = 'active'").get().c > 0, '/admin/products'],
    ['Connect Paystack (PAYSTACK_SECRET_KEY)', config.paystackEnabled(), '/admin/settings'],
    ['Review and approve your policy pages', d.prepare('SELECT COUNT(*) c FROM pages WHERE approved = 0').get().c === 0, '/admin/content/pages'],
    ['Set up email sending (SMTP)', !!config.smtp.host, '/admin/settings']
  ];
  res.admin('dashboard', {
    pageTitle: 'Dashboard', data, prof, rng, low: inventory.lowStock(d).slice(0, 8), out: inventory.outOfStock(d).slice(0, 8),
    checklist, showChecklist: checklist.some(c => !c[1]) && infra.can(req.staff.role, 'settings')
  });
});

router.get('/account', (req, res) => res.admin('account', { pageTitle: 'My account' }));
router.post('/account/password', lim('auth'), (req, res) => {
  const d = db(req);
  const u = d.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.staff.id);
  if (!bcrypt.compareSync(String(req.body.current || ''), u.password_hash)) res.flash('error', 'Your current password is not correct.');
  else if (!req.body.password || req.body.password.length < 10 || req.body.password !== req.body.password2) res.flash('error', 'New password must match and be at least 10 characters.');
  else { d.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.password, 12), req.staff.id); infra.audit(req, 'own_password_changed', 'user', req.staff.id); res.flash('success', 'Password changed.'); }
  res.redirect('/admin/account');
});

router.get('/help', (req, res) => res.admin('help', { pageTitle: 'Help' }));

/* ---------- sections ---------- */
router.use('/products', requirePerm('products'), require('./products'));
router.use('/inventory', requirePerm('inventory'), require('./inventory'));
router.use('/orders', requirePerm('orders'), require('./orders'));
router.use('/payments', requirePerm('payments'), require('./payments'));
router.use('/customers', requirePerm('customers'), require('./customers'));
router.use('/suppliers', requirePerm('suppliers'), require('./suppliers'));
router.use('/promotions', requirePerm('promotions'), require('./promotions'));
router.use('/deliveries', requirePerm('deliveries'), require('./deliveries'));
router.use('/reports', requirePerm('reports'), require('./reports'));
router.use('/expenses', requirePerm('expenses'), require('./expenses'));
router.use('/content', requirePerm('content'), require('./content'));
router.use('/settings', requirePerm('settings'), require('./settings'));
router.use('/users', requirePerm('users'), require('./users'));

module.exports = router;
