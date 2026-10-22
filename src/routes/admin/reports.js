'use strict';
const express = require('express');
const reports = require('../../services/reports');
const inventory = require('../../services/inventory');
const infra = require('../../lib/infra');
const util = require('../../lib/util');
const router = express.Router();
const db = req => req.app.locals.db;
const p = util.fromPesewas;

router.get('/', (req, res) => {
  const d = db(req);
  const r = reports.range(req.query.from, req.query.to);
  res.admin('reports', {
    pageTitle: 'Reports', ...r, profit: reports.profit(d, r.from, r.to), cash: reports.cashView(d, r.from, r.to),
    products: reports.productRevenue(d, r.from, r.to), categories: reports.categoryRevenue(d, r.from, r.to), methods: reports.paymentBreakdown(d, r.from, r.to),
    margins: reports.productMargins(d), valuation: inventory.valuation(d), balances: reports.supplierBalances(d),
    refunds: d.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM refunds WHERE status = 'processed' AND created_at BETWEEN ? AND ?").get(r.fromTs, r.toTs),
    cancelled: d.prepare("SELECT COUNT(*) c, COALESCE(SUM(total),0) s FROM orders WHERE status = 'cancelled' AND created_at BETWEEN ? AND ?").get(r.fromTs, r.toTs)
  });
});

router.get('/export/:name', (req, res) => {
  const d = db(req), r = reports.range(req.query.from, req.query.to);
  const name = req.params.name;
  infra.audit(req, 'report_exported', 'report', name);
  if (name === 'products') {
    return infra.sendCsv(res, `sales-by-product-${r.from}-to-${r.to}.csv`, ['Product', 'Brand', 'Units sold', 'Revenue', 'Cost of goods', 'Gross profit'],
      reports.productRevenue(d, r.from, r.to).map(x => [x.product_name, x.brand_name, x.units, p(x.revenue), p(x.cogs), p(x.revenue - x.cogs)]));
  }
  if (name === 'categories') {
    return infra.sendCsv(res, `sales-by-category-${r.from}-to-${r.to}.csv`, ['Category', 'Units', 'Revenue'], reports.categoryRevenue(d, r.from, r.to).map(x => [x.category, x.units, p(x.revenue)]));
  }
  if (name === 'profit') {
    const x = reports.profit(d, r.from, r.to);
    const rows = [
      ['Product sales (before discounts)', p(x.productSales)], ['Less: discounts given', p(-x.discounts)], ['Net product sales', p(x.netSales)], ['Less: cost of goods sold', p(-x.cogs)],
      ['GROSS PROFIT (products)', p(x.grossProfit)], ['Gross margin %', x.grossMarginPct.toFixed(1)], ['Markup %', x.markupPct.toFixed(1)], ['Add: delivery fees collected', p(x.deliveryFees)],
      ['Less: refunds', p(-x.refunds)], ['Less: payment fees (Paystack)', p(-x.paymentFees)], ...x.expenses.map(e => [`Less: expense – ${e.category}`, p(-e.amount)]),
      ['ESTIMATED NET OPERATING PROFIT', p(x.netProfit)], ['Is this an estimate?', x.isEstimate ? `YES – ${x.noCostLines} sold items have no cost recorded` : 'Based on recorded costs']];
    return infra.sendCsv(res, `profit-${r.from}-to-${r.to}.csv`, ['Line', 'GHS'], rows);
  }
  if (name === 'stock') {
    return infra.sendCsv(res, 'stock-valuation.csv', ['Product', 'Brand', 'Size', 'SKU', 'On hand', 'Reserved', 'Available', 'Avg cost', 'Stock value (cost)', 'Selling price', 'Gross profit/unit', 'Margin %', 'Markup %'],
      reports.productMargins(d).map(x => [x.product, x.brand, x.label, x.sku, x.on_hand, x.reserved, x.on_hand - x.reserved, p(x.cost), p(x.on_hand * x.cost), p(x.sell), p(x.grossProfit), x.marginPct.toFixed(1), x.markupPct === null ? '' : x.markupPct.toFixed(1)]));
  }
  if (name === 'suppliers') {
    return infra.sendCsv(res, 'supplier-balances.csv', ['Supplier', 'Goods received (value)', 'Paid', 'Still owed'], reports.supplierBalances(d).map(x => [x.name, p(x.received_value), p(x.paid), p(x.owed)]));
  }
  res.status(404).send('Unknown report');
});

module.exports = router;
