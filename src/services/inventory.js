'use strict';
/**
 * Inventory rules
 *  - on_hand  = units physically in stock (includes units reserved for unpaid/unshipped orders)
 *  - reserved = units promised to orders
 *  - available = on_hand - reserved   (this is what customers can still buy)
 * Every change writes a row in stock_movements. Nothing is silently overwritten.
 * All functions run inside a database transaction, so two customers can never
 * buy the same last unit and stock can never go negative.
 */

class StockError extends Error {
  constructor(message, variantId) { super(message); this.name = 'StockError'; this.variantId = variantId; }
}

function logMovement(db, v, m) {
  db.prepare(`INSERT INTO stock_movements
    (variant_id, type, on_hand_change, reserved_change, on_hand_after, reserved_after, unit_cost, reference, reason, user_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(v.id, m.type, m.onHandChange || 0, m.reservedChange || 0, v.on_hand, v.reserved,
    m.unitCost === undefined ? null : m.unitCost, m.reference || null, m.reason || null, m.userId || null);
}

function getVariant(db, id) {
  const v = db.prepare('SELECT * FROM product_variants WHERE id = ?').get(id);
  if (!v) throw new StockError('Variant not found', id);
  return v;
}

/** Low-level: apply deltas safely and log them. */
function move(db, variantId, m) {
  return db.transaction(() => {
    const dOn = m.onHandChange || 0;
    const dRes = m.reservedChange || 0;
    // The WHERE clause is the safety net: it only updates when the result stays valid.
    const r = db.prepare(`UPDATE product_variants
      SET on_hand = on_hand + ?, reserved = reserved + ?
      WHERE id = ? AND on_hand + ? >= 0 AND reserved + ? >= 0 AND on_hand + ? >= reserved + ?`)
      .run(dOn, dRes, variantId, dOn, dRes, dOn, dRes);
    if (r.changes !== 1) throw new StockError('Not enough stock for this change', variantId);
    logMovement(db, getVariant(db, variantId), m);
  })();
}

function available(v) { return v.on_hand - v.reserved; }

/* ---------- manual / purchasing operations ---------- */

function setOpeningStock(db, variantId, qty, unitCost, userId) {
  return db.transaction(() => {
    if (qty > 0) {
      db.prepare('UPDATE product_variants SET cost = ? WHERE id = ?').run(unitCost, variantId);
      move(db, variantId, { type: 'opening', onHandChange: qty, unitCost, reason: 'Opening stock', userId });
    } else {
      db.prepare('UPDATE product_variants SET cost = ? WHERE id = ?').run(unitCost, variantId);
    }
  })();
}

/** Goods received from a supplier. Updates the weighted-average cost. */
function receiveStock(db, variantId, qty, unitCost, opts = {}) {
  if (!(qty > 0)) throw new StockError('Quantity must be more than zero', variantId);
  return db.transaction(() => {
    const v = getVariant(db, variantId);
    const newCost = v.on_hand + qty > 0
      ? Math.round((v.on_hand * v.cost + qty * unitCost) / (v.on_hand + qty))
      : unitCost;
    db.prepare('UPDATE product_variants SET cost = ?, batch_no = COALESCE(?, batch_no), expiry_date = COALESCE(?, expiry_date) WHERE id = ?')
      .run(newCost, opts.batch || null, opts.expiry || null, variantId);
    move(db, variantId, { type: 'purchase', onHandChange: qty, unitCost, reference: opts.reference, reason: opts.reason || 'Goods received', userId: opts.userId });
  })();
}

/** Manual change. A reason and a user are mandatory. */
function adjustStock(db, variantId, delta, reason, userId, type = 'adjustment') {
  if (!reason || !String(reason).trim()) throw new StockError('A reason is required for every manual stock change', variantId);
  if (!userId) throw new StockError('A signed-in user is required', variantId);
  if (!delta) throw new StockError('Change cannot be zero', variantId);
  return move(db, variantId, { type, onHandChange: delta, reason: String(reason).trim(), userId });
}

/** Physical count: records the difference between the system and the shelf. */
function stockCount(db, variantId, counted, reason, userId) {
  return db.transaction(() => {
    const v = getVariant(db, variantId);
    const delta = counted - v.on_hand;
    if (delta === 0) return 0;
    if (counted < v.reserved) throw new StockError(`Counted ${counted} is less than the ${v.reserved} units already reserved for orders`, variantId);
    move(db, variantId, { type: 'count', onHandChange: delta, reason: `Stock count (${v.on_hand} → ${counted}). ${reason || ''}`.trim(), userId });
    return delta;
  })();
}

/* ---------- order operations ---------- */

function orderItems(db, orderId) {
  return db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
}

function setState(db, orderId, state) {
  db.prepare("UPDATE orders SET stock_state = ?, updated_at = datetime('now') WHERE id = ?").run(state, orderId);
}

/** Hold stock for an order. Throws StockError (and changes nothing) if anything is short. */
function reserveForOrder(db, orderId) {
  return db.transaction(() => {
    const order = db.prepare('SELECT order_no, stock_state FROM orders WHERE id = ?').get(orderId);
    if (order.stock_state === 'reserved' || order.stock_state === 'deducted') return false;
    for (const it of orderItems(db, orderId)) {
      move(db, it.variant_id, { type: 'reserve', reservedChange: it.qty, reference: order.order_no, reason: 'Reserved for order' });
    }
    setState(db, orderId, 'reserved');
    return true;
  })();
}

/** Payment confirmed (or COD dispatched): units leave the shelf. */
function commitOrder(db, orderId) {
  return db.transaction(() => {
    const order = db.prepare('SELECT order_no, stock_state FROM orders WHERE id = ?').get(orderId);
    if (order.stock_state === 'deducted') return false;
    if (order.stock_state !== 'reserved') throw new StockError('Stock is not reserved for this order', null);
    for (const it of orderItems(db, orderId)) {
      const v = getVariant(db, it.variant_id);
      move(db, it.variant_id, { type: 'sale', onHandChange: -it.qty, reservedChange: -it.qty, unitCost: v.cost, reference: order.order_no, reason: 'Sold' });
      db.prepare('UPDATE order_items SET unit_cost = ? WHERE id = ?').run(v.cost, it.id);
    }
    setState(db, orderId, 'deducted');
    return true;
  })();
}

/** Order cancelled/expired before the stock left: give the reservation back. */
function releaseOrder(db, orderId) {
  return db.transaction(() => {
    const order = db.prepare('SELECT order_no, stock_state FROM orders WHERE id = ?').get(orderId);
    if (order.stock_state !== 'reserved') return false;
    for (const it of orderItems(db, orderId)) {
      move(db, it.variant_id, { type: 'release', reservedChange: -it.qty, reference: order.order_no, reason: 'Reservation released' });
    }
    setState(db, orderId, 'released');
    return true;
  })();
}

/** Stock already deducted comes back (cancelled after sale, or a resaleable return). */
function restoreOrder(db, orderId, opts = {}) {
  return db.transaction(() => {
    const order = db.prepare('SELECT order_no, stock_state FROM orders WHERE id = ?').get(orderId);
    if (order.stock_state !== 'deducted') return false;
    const type = opts.type || 'return';
    for (const it of orderItems(db, orderId)) {
      move(db, it.variant_id, { type, onHandChange: it.qty, reference: order.order_no, reason: opts.reason || 'Stock returned', userId: opts.userId });
    }
    setState(db, orderId, 'restored');
    return true;
  })();
}

/* ---------- queries ---------- */

function lowStock(db) {
  return db.prepare(`SELECT v.*, p.name AS product_name, p.slug, b.name AS brand_name
    FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN brands b ON b.id = p.brand_id
    WHERE v.active = 1 AND p.status = 'active' AND v.on_hand - v.reserved > 0 AND v.on_hand - v.reserved <= v.low_stock_threshold
    ORDER BY v.on_hand - v.reserved, p.name`).all();
}

function outOfStock(db) {
  return db.prepare(`SELECT v.*, p.name AS product_name, p.slug, b.name AS brand_name
    FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN brands b ON b.id = p.brand_id
    WHERE v.active = 1 AND p.status = 'active' AND v.on_hand - v.reserved <= 0
    ORDER BY p.name`).all();
}

function valuation(db) {
  return db.prepare(`SELECT COALESCE(SUM(on_hand * cost),0) AS cost_value, COALESCE(SUM(on_hand * price),0) AS retail_value, COALESCE(SUM(on_hand),0) AS units
    FROM product_variants WHERE active = 1`).get();
}

module.exports = { StockError, move, available, setOpeningStock, receiveStock, adjustStock, stockCount, reserveForOrder, commitOrder, releaseOrder, restoreOrder, lowStock, outOfStock, valuation, getVariant };
