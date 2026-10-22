'use strict';
/** Small infrastructure helpers: audit log, mail, CSRF, session store, CSV, permissions. */
const session = require('express-session');
const nodemailer = require('nodemailer');
const config = require('../config');
const dbm = require('../db');
const util = require('./util');

/* The app registers its database here, so helpers need no connection passed in. */
let appDb = null;
const useDb = db => { appDb = db; };
const theDb = () => appDb || dbm.get();

/* ---------- audit log ---------- */
function audit(req, action, entity, entityId, detail) {
  try {
    const u = req && req.staff;
    theDb().prepare('INSERT INTO audit_logs (user_id, user_label, action, entity, entity_id, detail, ip) VALUES (?,?,?,?,?,?,?)')
      .run(u ? u.id : null, u ? `${u.name} <${u.email}>` : 'system', action, entity || null, entityId === undefined || entityId === null ? null : String(entityId),
        detail ? String(detail).slice(0, 1000) : null, req && req.ip ? req.ip : null);
  } catch (e) { console.error('audit failed', e.message); }
}

/* ---------- email (falls back to an on-screen outbox when SMTP is not set up) ---------- */
let transport = null;
function getTransport() {
  if (!config.smtp.host) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined
    });
  }
  return transport;
}

async function sendMail(to, subject, text, db = theDb()) {
  if (!to) return;
  const id = Number(db.prepare('INSERT INTO notifications (recipient, subject, body, status) VALUES (?,?,?,?)').run(to, subject, text, 'queued').lastInsertRowid);
  const t = getTransport();
  if (!t) {
    db.prepare("UPDATE notifications SET status = 'logged' WHERE id = ?").run(id);
    if (!config.isProd) console.log(`[email not sent – SMTP not set up] To: ${to} | ${subject}`);
    return;
  }
  try {
    await t.sendMail({ from: config.smtp.from || config.smtp.user, to, subject, text });
    db.prepare("UPDATE notifications SET status = 'sent' WHERE id = ?").run(id);
  } catch (e) {
    db.prepare("UPDATE notifications SET status = 'failed', error = ? WHERE id = ?").run(String(e.message).slice(0, 300), id);
  }
}

/* ---------- CSRF (per-session token; webhooks are exempt) ---------- */
function csrf(req, res, next) {
  if (!req.session) return next(new Error('Session missing'));
  // The token (and so the session) is only created when a page actually prints a form.
  Object.defineProperty(res.locals, 'csrfToken', {
    configurable: true, enumerable: true,
    get() { if (!req.session.csrf) req.session.csrf = util.token(24); return req.session.csrf; }
  });
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || req.query._csrf;
  if (!sent || !req.session.csrf || !util.safeEqual(sent, req.session.csrf)) {
    return res.status(403).render('fatal', { title: 'Session expired', message: 'Your form expired. Please go back, refresh the page and try again.', layout: false });
  }
  next();
}

/* ---------- SQLite-backed session store ---------- */
class SqliteStore extends session.Store {
  constructor(db) { super(); this.db = db; }
  get(sid, cb) {
    try {
      const r = this.db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
      if (!r || r.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(r.data));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      this.db.prepare('INSERT INTO sessions (sid, data, expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires')
        .run(sid, JSON.stringify(sess), exp);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) { try { this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb && cb(null); } catch (e) { cb && cb(e); } }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
  cleanup() { this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()); }
}

/* ---------- CSV ---------- */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;       // stops spreadsheet formula injection
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(headers, rows) {
  return [headers.map(csvCell).join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\r\n');
}
function sendCsv(res, filename, headers, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + toCsv(headers, rows));
}

/* ---------- role permissions ---------- */
const PERMISSIONS = {
  owner: ['dashboard', 'products', 'inventory', 'orders', 'payments', 'refunds', 'customers', 'suppliers', 'promotions', 'deliveries', 'reports', 'expenses', 'content', 'settings', 'users'],
  manager: ['dashboard', 'products', 'inventory', 'orders', 'payments', 'refunds', 'customers', 'suppliers', 'promotions', 'deliveries', 'reports', 'expenses', 'content'],
  sales: ['dashboard', 'orders', 'customers', 'deliveries'],
  inventory: ['dashboard', 'products', 'inventory', 'suppliers']
};
const ROLE_LABELS = { owner: 'Owner', manager: 'Store manager', sales: 'Sales / order processing', inventory: 'Inventory staff' };
function can(role, perm) { return (PERMISSIONS[role] || []).includes(perm); }

module.exports = { useDb, audit, sendMail, csrf, SqliteStore, toCsv, sendCsv, PERMISSIONS, ROLE_LABELS, can };
