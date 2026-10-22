'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const util = require('../../lib/util');
const infra = require('../../lib/infra');
const router = express.Router();
const db = req => req.app.locals.db;
const ROLES = Object.keys(infra.ROLE_LABELS);

router.get('/', (req, res) => res.admin('users', { pageTitle: 'Staff & permissions', users: db(req).prepare('SELECT id, name, email, role, active, last_login FROM users ORDER BY id').all(), ROLES, PERMISSIONS: infra.PERMISSIONS }));

router.post('/', (req, res) => {
  const d = db(req);
  const email = util.clean(req.body.email, 254).toLowerCase(), name = util.clean(req.body.name, 100);
  const role = ROLES.includes(req.body.role) ? req.body.role : 'sales';
  const errors = [];
  if (!util.isEmail(email)) errors.push('Enter a valid email.');
  if (name.length < 2) errors.push('Enter a name.');
  if (!req.body.password || req.body.password.length < 10) errors.push('The temporary password must be at least 10 characters.');
  if (d.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(email)) errors.push('That email already has an account.');
  if (errors.length) { res.flash('error', errors.join(' ')); return res.redirect('/admin/users'); }
  const id = Number(d.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)').run(email, name, bcrypt.hashSync(req.body.password, 12), role).lastInsertRowid);
  infra.audit(req, 'user_created', 'user', id, `${email} as ${role}`);
  res.flash('success', 'Staff account created. Give them the temporary password privately and ask them to change it.');
  res.redirect('/admin/users');
});

function ownersLeft(d, exceptId) { return d.prepare("SELECT COUNT(*) c FROM users WHERE role = 'owner' AND active = 1 AND id != ?").get(exceptId).c; }

router.post('/:id', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  const u = d.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.redirect('/admin/users');
  const role = ROLES.includes(req.body.role) ? req.body.role : u.role;
  const active = req.body.active ? 1 : 0;
  if ((role !== 'owner' || !active) && u.role === 'owner' && ownersLeft(d, id) === 0) { res.flash('error', 'There must always be at least one active owner.'); return res.redirect('/admin/users'); }
  if (id === req.staff.id && !active) { res.flash('error', 'You cannot switch off your own account.'); return res.redirect('/admin/users'); }
  d.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(util.clean(req.body.name, 100) || u.name, role, active, id);
  if (req.body.password) {
    if (req.body.password.length < 10) { res.flash('error', 'New password must be at least 10 characters.'); return res.redirect('/admin/users'); }
    d.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.password, 12), id);
    d.prepare('DELETE FROM sessions WHERE data LIKE ?').run(`%"staffId":${id},%`);
    infra.audit(req, 'user_password_set', 'user', id);
  }
  infra.audit(req, 'user_updated', 'user', id, `role ${u.role}→${role}, active ${u.active}→${active}`);
  res.flash('success', 'Saved.');
  res.redirect('/admin/users');
});

module.exports = router;
