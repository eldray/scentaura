'use strict';
/**
 * Reports. Important definitions (also explained on the Reports page):
 *  - A "sale" is an order that has been PAID (online, or cash collected) and is not cancelled.
 *  - Revenue is not profit, and profit is not cash in the bank.
 *  - Cost of goods = the average cost recorded when the item was sold. If a product has no cost
 *    recorded, profit for it is overstated, so the report warns you.
 */

const PAID_CTE = `WITH paid AS (
  SELECT o.*, (SELECT MIN(pm.paid_at) FROM payments pm WHERE pm.order_id = o.id AND pm.status IN ('success','partially_refunded','refunded')) AS paid_at
  FROM orders o WHERE o.payment_status IN ('paid','partially_refunded') AND o.status != 'cancelled')`;

function range(from, to) {
  const f = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const t = /^\d{4}-\d{2}-\d{2}$/.test(to || '') ? to : new Date().toISOString().slice(0, 10);
  return { from: f, to: t, fromTs: `${f} 00:00:00`, toTs: `${t} 23:59:59` };
}

function sumSales(db, fromTs, toTs) {
  return db.prepare(`${PAID_CTE} SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue FROM paid WHERE paid_at BETWEEN ? AND ?`).get(fromTs, toTs);
}

function dashboard(db) {
  const today = new Date().toISOString().slice(0, 10);
  const t0 = `${today} 00:00:00`, t1 = `${today} 23:59:59`;
  const weekStart = db.prepare("SELECT date('now','-6 days','weekday 1') d").get().d;
  const monthStart = db.prepare("SELECT date('now','start of month') d").get().d;
  const c = (sql, ...a) => db.prepare(sql).get(...a).c;
  return {
    today: sumSales(db, t0, t1),
    week: sumSales(db, `${weekStart} 00:00:00`, t1),
    month: sumSales(db, `${monthStart} 00:00:00`, t1),
    totalOrders: c('SELECT COUNT(*) c FROM orders'),
    pending: c("SELECT COUNT(*) c FROM orders WHERE status IN ('pending_confirmation','payment_pending')"),
    paidOrders: c("SELECT COUNT(*) c FROM orders WHERE payment_status IN ('paid','partially_refunded')"),
    unpaidOrders: c("SELECT COUNT(*) c FROM orders WHERE payment_status IN ('unpaid','pending','failed','cancelled') AND status NOT IN ('cancelled')"),
    awaitingDispatch: c("SELECT COUNT(*) c FROM orders WHERE status IN ('paid','processing','packed') OR (payment_method = 'cod' AND status = 'pending_confirmation')"),
    delivered: c("SELECT COUNT(*) c FROM orders WHERE status = 'delivered'"),
    needsAttention: db.prepare('SELECT id, order_no, needs_attention FROM orders WHERE needs_attention IS NOT NULL ORDER BY id DESC LIMIT 10').all(),
    codOutstanding: db.prepare("SELECT COUNT(*) c, COALESCE(SUM(total),0) s FROM orders WHERE payment_method = 'cod' AND payment_status = 'unpaid' AND status = 'delivered'").get(),
    pendingReviews: c("SELECT COUNT(*) c FROM reviews WHERE status = 'pending'")
  };
}

function productRevenue(db, from, to) {
  const r = range(from, to);
  return db.prepare(`${PAID_CTE}
    SELECT i.product_name, i.brand_name, SUM(i.qty) AS units, SUM(i.line_total) AS revenue, SUM(i.unit_cost * i.qty) AS cogs
    FROM order_items i JOIN paid ON paid.id = i.order_id WHERE paid.paid_at BETWEEN ? AND ?
    GROUP BY i.product_name, i.brand_name ORDER BY revenue DESC`).all(r.fromTs, r.toTs);
}

function categoryRevenue(db, from, to) {
  const r = range(from, to);
  return db.prepare(`${PAID_CTE}
    SELECT COALESCE(NULLIF(i.category_name,''),'Uncategorised') AS category, SUM(i.qty) AS units, SUM(i.line_total) AS revenue
    FROM order_items i JOIN paid ON paid.id = i.order_id WHERE paid.paid_at BETWEEN ? AND ?
    GROUP BY 1 ORDER BY revenue DESC`).all(r.fromTs, r.toTs);
}

function paymentBreakdown(db, from, to) {
  const r = range(from, to);
  return db.prepare(`${PAID_CTE}
    SELECT CASE WHEN paid.payment_method = 'cod' THEN 'Cash on delivery / pickup' ELSE 'Online (Paystack)' END AS method,
      COUNT(*) AS orders, SUM(total) AS amount
    FROM paid WHERE paid_at BETWEEN ? AND ? GROUP BY 1`).all(r.fromTs, r.toTs);
}

function profit(db, from, to) {
  const r = range(from, to);
  const s = db.prepare(`${PAID_CTE}
    SELECT COUNT(*) AS orders, COALESCE(SUM(subtotal),0) AS product_sales, COALESCE(SUM(discount),0) AS discounts,
      COALESCE(SUM(delivery_fee),0) AS delivery_fees
    FROM paid WHERE paid_at BETWEEN ? AND ?`).get(r.fromTs, r.toTs);
  const cg = db.prepare(`${PAID_CTE}
    SELECT COALESCE(SUM(i.unit_cost * i.qty),0) AS cogs,
      COALESCE(SUM(CASE WHEN i.unit_cost = 0 THEN 1 ELSE 0 END),0) AS no_cost_lines
    FROM order_items i JOIN paid ON paid.id = i.order_id WHERE paid.paid_at BETWEEN ? AND ?`).get(r.fromTs, r.toTs);
  const refunds = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM refunds WHERE status = 'processed' AND created_at BETWEEN ? AND ?").get(r.fromTs, r.toTs).s;
  const fees = db.prepare("SELECT COALESCE(SUM(fee),0) s FROM payments WHERE provider = 'paystack' AND status IN ('success','partially_refunded','refunded') AND paid_at BETWEEN ? AND ?").get(r.fromTs, r.toTs).s;
  const expenses = db.prepare('SELECT category, SUM(amount) AS amount FROM expenses WHERE spent_on BETWEEN ? AND ? GROUP BY category ORDER BY amount DESC').all(r.from, r.to);
  const opex = expenses.reduce((a, e) => a + e.amount, 0);
  const deliveryCosts = expenses.filter(e => e.category === 'Delivery costs').reduce((a, e) => a + e.amount, 0);

  const netSales = s.product_sales - s.discounts;
  const gross = netSales - cg.cogs;
  const net = gross + s.delivery_fees - refunds - fees - opex;
  return {
    ...r, orders: s.orders, productSales: s.product_sales, discounts: s.discounts, netSales,
    deliveryFees: s.delivery_fees, deliveryCosts, cogs: cg.cogs, grossProfit: gross,
    grossMarginPct: netSales > 0 ? (gross / netSales) * 100 : 0,
    markupPct: cg.cogs > 0 ? (gross / cg.cogs) * 100 : 0,
    refunds, paymentFees: fees, expenses, operatingExpenses: opex, netProfit: net,
    noCostLines: cg.no_cost_lines,
    isEstimate: cg.no_cost_lines > 0
  };
}

/** Money movement, kept separate from profit on purpose. */
function cashView(db, from, to) {
  const r = range(from, to);
  const collected = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status IN ('success','partially_refunded','refunded') AND paid_at BETWEEN ? AND ?").get(r.fromTs, r.toTs).s;
  const fees = db.prepare("SELECT COALESCE(SUM(fee),0) s FROM payments WHERE provider = 'paystack' AND status IN ('success','partially_refunded','refunded') AND paid_at BETWEEN ? AND ?").get(r.fromTs, r.toTs).s;
  const refunds = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM refunds WHERE status = 'processed' AND created_at BETWEEN ? AND ?").get(r.fromTs, r.toTs).s;
  const expenses = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE spent_on BETWEEN ? AND ?').get(r.from, r.to).s;
  const supplier = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM supplier_payments WHERE paid_on BETWEEN ? AND ?').get(r.from, r.to).s;
  return { collected, fees, refunds, expenses, supplierPaid: supplier, net: collected - fees - refunds - expenses - supplier };
}

function reconciliation(db, from, to) {
  const r = range(from, to);
  const rows = db.prepare(`SELECT p.id, p.reference, p.provider, p.channel, p.amount, p.fee, p.status, p.paid_at, p.created_at,
      o.order_no, o.total AS order_total, o.payment_status AS order_payment_status, o.status AS order_status,
      (SELECT COALESCE(SUM(amount),0) FROM refunds rf WHERE rf.payment_id = p.id AND rf.status = 'processed') AS refunded
    FROM payments p JOIN orders o ON o.id = p.order_id
    WHERE p.created_at BETWEEN ? AND ? ORDER BY p.created_at DESC`).all(r.fromTs, r.toTs);
  for (const x of rows) {
    const issues = [];
    if (x.status === 'success' && x.amount !== x.order_total) issues.push('Amount differs from order total');
    if (x.status === 'success' && !['paid', 'partially_refunded', 'refunded'].includes(x.order_payment_status)) issues.push('Payment succeeded but order is not marked paid');
    if (x.status !== 'success' && x.order_payment_status === 'paid' && x.provider === 'paystack') issues.push('Order marked paid without a successful payment');
    x.issues = issues;
  }
  const orphan = db.prepare(`SELECT o.order_no, o.total FROM orders o WHERE o.payment_status = 'paid' AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status IN ('success','partially_refunded','refunded'))`).all();
  return { ...r, rows, orphan, totals: {
    success: rows.filter(x => x.status === 'success' || x.status === 'partially_refunded' || x.status === 'refunded').reduce((a, x) => a + x.amount, 0),
    pending: rows.filter(x => x.status === 'pending').reduce((a, x) => a + x.amount, 0),
    fees: rows.reduce((a, x) => a + (x.fee || 0), 0),
    refunded: rows.reduce((a, x) => a + x.refunded, 0),
    issues: rows.filter(x => x.issues.length).length + orphan.length
  } };
}

function supplierBalances(db) {
  return db.prepare(`SELECT s.id, s.name,
      COALESCE((SELECT SUM(pi.qty_received * pi.unit_cost) FROM purchase_items pi JOIN purchase_orders po ON po.id = pi.purchase_order_id WHERE po.supplier_id = s.id AND po.status != 'cancelled'),0) AS received_value,
      COALESCE((SELECT SUM(amount) FROM supplier_payments sp WHERE sp.supplier_id = s.id),0) AS paid
    FROM suppliers s ORDER BY s.name`).all().map(x => ({ ...x, owed: x.received_value - x.paid }));
}

function productMargins(db) {
  return db.prepare(`SELECT p.name AS product, b.name AS brand, v.label, v.sku, v.price, v.discount_price, v.cost, v.on_hand, v.reserved
    FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN brands b ON b.id = p.brand_id
    WHERE p.status != 'archived' ORDER BY p.name, v.size_ml`).all().map(x => {
    const sell = x.discount_price !== null && x.discount_price < x.price ? x.discount_price : x.price;
    const gp = sell - x.cost;
    return { ...x, sell, grossProfit: gp, marginPct: sell > 0 ? gp / sell * 100 : 0, markupPct: x.cost > 0 ? gp / x.cost * 100 : null };
  });
}

module.exports = { range, dashboard, productRevenue, categoryRevenue, paymentBreakdown, profit, cashView, reconciliation, supplierBalances, productMargins, PAID_CTE };
