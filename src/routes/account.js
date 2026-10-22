'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const util = require('../lib/util');
const infra = require('../lib/infra');
const { requireCustomer } = require('./shop');
const router = express.Router();

const db = req => req.app.locals.db;
const lim = name => (req, res, next) => req.app.locals.limiters[name](req, res, next);
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

function strongEnough(pw) { return typeof pw === 'string' && pw.length >= 8 && pw.length <= 128; }

function newReferralCode(d) {
  for (let i = 0; i < 10; i++) {
    const c = 'REF' + util.randomCode(6);
    if (!d.prepare('SELECT 1 FROM customers WHERE referral_code = ?').get(c)) return c;
  }
  return 'REF' + util.token(5).toUpperCase();
}

/** New session id after sign-in (stops session fixation) while keeping the cart. */
function startSession(req, key, id, cb) {
  const keep = { cart: req.session.cart, couponCode: req.session.couponCode, returnTo: req.session.returnTo };
  req.session.regenerate(err => {
    if (err) return cb(err);
    Object.assign(req.session, keep);
    req.session[key] = id;
    cb(null);
  });
}

function safeReturn(url) { return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/account'; }

router.get('/register', (req, res) => res.page('account/register', { title: 'Create an account', noindex: true, errors: [], v: { ref: req.query.ref || '' } }));

router.post('/register', lim('auth'), (req, res) => {
  const d = db(req);
  const v = { name: util.clean(req.body.name, 120), email: util.clean(req.body.email, 254).toLowerCase(), phone: util.clean(req.body.phone, 30), ref: util.clean(req.body.ref, 20), consent: req.body.marketingConsent === '1' };
  const phone = util.normalizeGhPhone(v.phone);
  const errors = [];
  if (v.name.length < 2) errors.push('Please enter your name.');
  if (!util.isEmail(v.email)) errors.push('Please enter a valid email address.');
  if (v.phone && !phone) errors.push('That phone number does not look right. Example: 024 123 4567.');
  if (!strongEnough(req.body.password)) errors.push('Your password must be at least 8 characters.');
  if (req.body.password !== req.body.password2) errors.push('The two passwords do not match.');
  if (!errors.length && d.prepare('SELECT 1 FROM customers WHERE email = ? COLLATE NOCASE').get(v.email)) errors.push('An account with this email already exists. Try signing in.');
  if (errors.length) return res.status(400).page('account/register', { title: 'Create an account', noindex: true, errors, v });

  const referrer = v.ref ? d.prepare('SELECT id FROM customers WHERE referral_code = ? COLLATE NOCASE').get(v.ref) : null;
  const hash = bcrypt.hashSync(req.body.password, 12);
  const id = Number(d.prepare(`INSERT INTO customers (email, name, phone, password_hash, marketing_consent, marketing_consent_at, referral_code, referred_by)
    VALUES (?,?,?,?,?,?,?,?)`).run(v.email, v.name, phone, hash, v.consent ? 1 : 0, v.consent ? util.nowSql() : null, newReferralCode(d), referrer ? referrer.id : null).lastInsertRowid);
  startSession(req, 'customerId', id, err => {
    if (err) throw err;
    res.flash('success', 'Welcome! Your account is ready.');
    res.redirect('/account');
  });
});

router.get('/login', (req, res) => res.page('account/login', { title: 'Sign in', noindex: true, error: null, email: '' }));

router.post('/login', lim('auth'), (req, res) => {
  const email = util.clean(req.body.email, 254).toLowerCase();
  const c = db(req).prepare('SELECT * FROM customers WHERE email = ? COLLATE NOCASE').get(email);
  const ok = bcrypt.compareSync(String(req.body.password || ''), c && c.password_hash ? c.password_hash : DUMMY_HASH) && c && c.password_hash;
  if (!ok) return res.status(401).page('account/login', { title: 'Sign in', noindex: true, error: 'Incorrect email or password.', email });
  const ret = safeReturn(req.session.returnTo);
  startSession(req, 'customerId', c.id, err => { if (err) throw err; delete req.session.returnTo; res.redirect(ret); });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('sa.sid'); res.redirect('/'); });
});

router.get('/account', requireCustomer, (req, res) => {
  const d = db(req);
  const myOrders = d.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC').all(req.customer.id);
  const referrals = d.prepare('SELECT COUNT(*) c FROM customers WHERE referred_by = ?').get(req.customer.id).c;
  res.page('account/index', { title: 'My account', noindex: true, myOrders, referrals, pwError: null });
});

router.post('/account/profile', requireCustomer, (req, res) => {
  const name = util.clean(req.body.name, 120);
  const phone = util.normalizeGhPhone(req.body.phone);
  if (name.length < 2 || (req.body.phone && !phone)) { res.flash('error', 'Please check your name and phone number.'); return res.redirect('/account'); }
  const consent = req.body.marketingConsent === '1' ? 1 : 0;
  const was = req.customer.marketing_consent;
  db(req).prepare('UPDATE customers SET name = ?, phone = ?, marketing_consent = ?, marketing_consent_at = CASE WHEN ? = 1 AND marketing_consent = 0 THEN datetime(\'now\') ELSE marketing_consent_at END WHERE id = ?')
    .run(name, phone, consent, consent, req.customer.id);
  res.flash('success', was !== consent ? 'Your contact preferences were updated.' : 'Your details were saved.');
  res.redirect('/account');
});

router.post('/account/password', requireCustomer, lim('auth'), (req, res) => {
  const c = db(req).prepare('SELECT password_hash FROM customers WHERE id = ?').get(req.customer.id);
  if (!bcrypt.compareSync(String(req.body.current || ''), c.password_hash)) res.flash('error', 'Your current password is not correct.');
  else if (!strongEnough(req.body.password) || req.body.password !== req.body.password2) res.flash('error', 'New passwords must match and be at least 8 characters.');
  else {
    db(req).prepare('UPDATE customers SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.password, 12), req.customer.id);
    res.flash('success', 'Password changed.');
  }
  res.redirect('/account');
});

/* ---------- forgot / reset password ---------- */
router.get('/forgot', (req, res) => res.page('account/forgot', { title: 'Forgot password', noindex: true, sent: false }));

router.post('/forgot', lim('reset'), (req, res) => {
  const d = db(req);
  const email = util.clean(req.body.email, 254).toLowerCase();
  const c = d.prepare('SELECT id, name, email FROM customers WHERE email = ? COLLATE NOCASE').get(email);
  if (c) {
    const t = util.token(32);
    d.prepare("UPDATE customers SET reset_token_hash = ?, reset_expires = datetime('now','+1 hour') WHERE id = ?").run(util.sha256(t), c.id);
    infra.sendMail(c.email, 'Reset your password', `Hello ${c.name},\n\nUse this link within one hour to choose a new password:\n${config.baseUrl}/reset/${t}\n\nIf you did not ask for this, ignore this email.`, d).catch(() => {});
  }
  // Same answer whether or not the email exists.
  res.page('account/forgot', { title: 'Forgot password', noindex: true, sent: true });
});

function findReset(d, token) {
  return d.prepare("SELECT id FROM customers WHERE reset_token_hash = ? AND reset_expires > datetime('now')").get(util.sha256(String(token)));
}

router.get('/reset/:token', (req, res) => {
  res.page('account/reset', { title: 'Choose a new password', noindex: true, valid: !!findReset(db(req), req.params.token), token: req.params.token, error: null });
});

router.post('/reset/:token', lim('reset'), (req, res) => {
  const d = db(req);
  const c = findReset(d, req.params.token);
  if (!c) return res.status(400).page('account/reset', { title: 'Choose a new password', noindex: true, valid: false, token: '', error: null });
  if (!strongEnough(req.body.password) || req.body.password !== req.body.password2) {
    return res.status(400).page('account/reset', { title: 'Choose a new password', noindex: true, valid: true, token: req.params.token, error: 'Passwords must match and be at least 8 characters.' });
  }
  d.prepare('UPDATE customers SET password_hash = ?, reset_token_hash = NULL, reset_expires = NULL WHERE id = ?').run(bcrypt.hashSync(req.body.password, 12), c.id);
  res.flash('success', 'Your password has been changed. Please sign in.');
  res.redirect('/login');
});

module.exports = router;
