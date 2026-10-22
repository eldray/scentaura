'use strict';
const express = require('express');
const util = require('../../lib/util');
const infra = require('../../lib/infra');
const { EXPENSE_CATEGORIES } = require('../../lib/defaults');
const router = express.Router();
const db = req => req.app.locals.db;

router.get('/', (req, res) => {
  const d = db(req);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : new Date().toISOString().slice(0, 8) + '01';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : new Date().toISOString().slice(0, 10);
  const rows = d.prepare('SELECT e.*, u.name AS user_name FROM expenses e LEFT JOIN users u ON u.id = e.user_id WHERE spent_on BETWEEN ? AND ? ORDER BY spent_on DESC, id DESC').all(from, to);
  if (req.query.format === 'csv') return infra.sendCsv(res, `expenses-${from}-to-${to}.csv`, ['Date', 'Category', 'Description', 'Amount (GHS)', 'Recorded by'], rows.map(r => [r.spent_on, r.category, r.description, util.fromPesewas(r.amount), r.user_name]));
  res.admin('expenses', { pageTitle: 'Expenses', rows, from, to, categories: EXPENSE_CATEGORIES, total: rows.reduce((a, r) => a + r.amount, 0), today: new Date().toISOString().slice(0, 10) });
});

router.post('/', (req, res) => {
  const amount = util.toPesewas(req.body.amount);
  const category = EXPENSE_CATEGORIES.includes(req.body.category) ? req.body.category : 'Other';
  if (!amount) { res.flash('error', 'Enter the amount, for example 85.50.'); return res.redirect('/admin/expenses'); }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.spent_on || '') ? req.body.spent_on : new Date().toISOString().slice(0, 10);
  const id = Number(db(req).prepare('INSERT INTO expenses (spent_on, category, description, amount, user_id) VALUES (?,?,?,?,?)').run(date, category, util.clean(req.body.description, 200), amount, req.staff.id).lastInsertRowid);
  infra.audit(req, 'expense_added', 'expense', id, `${category} ${amount}`);
  res.flash('success', 'Expense recorded.');
  res.redirect('/admin/expenses');
});

router.post('/:id/delete', (req, res) => {
  db(req).prepare('DELETE FROM expenses WHERE id = ?').run(util.int(req.params.id));
  infra.audit(req, 'expense_deleted', 'expense', req.params.id);
  res.redirect('/admin/expenses');
});

module.exports = router;
