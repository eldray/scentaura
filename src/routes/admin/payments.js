'use strict';
const express = require('express');
const reports = require('../../services/reports');
const infra = require('../../lib/infra');
const util = require('../../lib/util');
const router = express.Router();
const db = req => req.app.locals.db;

router.get('/', (req, res) => {
  const r = reports.range(req.query.from, req.query.to);
  const rec = reports.reconciliation(db(req), r.from, r.to);
  if (req.query.format === 'csv') {
    return infra.sendCsv(res, `payment-reconciliation-${r.from}-to-${r.to}.csv`,
      ['Created (UTC)', 'Paid (UTC)', 'Order', 'Provider', 'Channel', 'Reference', 'Amount', 'Fee', 'Refunded', 'Payment status', 'Order total', 'Order payment status', 'Problems'],
      rec.rows.map(x => [x.created_at, x.paid_at, x.order_no, x.provider, x.channel, x.reference, util.fromPesewas(x.amount), util.fromPesewas(x.fee), util.fromPesewas(x.refunded), x.status, util.fromPesewas(x.order_total), x.order_payment_status, x.issues.join('; ')]));
  }
  res.admin('payments', { pageTitle: 'Payments & reconciliation', rec, ...r });
});

module.exports = router;
