'use strict';
const util = require('../lib/util');

const EFFECTIVE = 'CASE WHEN v.discount_price IS NOT NULL AND v.discount_price < v.price THEN v.discount_price ELSE v.price END';

const CARD_SQL = `
  SELECT p.*, b.name AS brand_name, b.slug AS brand_slug, c.name AS category_name, c.slug AS category_slug,
    (SELECT MIN(${EFFECTIVE}) FROM product_variants v WHERE v.product_id = p.id AND v.active = 1) AS min_price,
    (SELECT v.price FROM product_variants v WHERE v.product_id = p.id AND v.active = 1 ORDER BY ${EFFECTIVE} ASC, v.price ASC LIMIT 1) AS compare_price,
    (SELECT COUNT(*) FROM product_variants v WHERE v.product_id = p.id AND v.active = 1 AND v.discount_price IS NOT NULL AND v.discount_price < v.price) AS sale_variants,
    (SELECT COALESCE(SUM(v.on_hand - v.reserved), 0) FROM product_variants v WHERE v.product_id = p.id AND v.active = 1) AS stock,
    (SELECT COUNT(*) FROM product_variants v WHERE v.product_id = p.id AND v.active = 1) AS variant_count,
    (SELECT v.id FROM product_variants v WHERE v.product_id = p.id AND v.active = 1 AND v.on_hand - v.reserved > 0 ORDER BY ${EFFECTIVE} ASC, v.id LIMIT 1) AS quick_variant_id,
    (SELECT thumb_path FROM product_images i WHERE i.product_id = p.id ORDER BY i.sort, i.id LIMIT 1) AS thumb,
    (SELECT ROUND(AVG(r.rating), 1) FROM reviews r WHERE r.product_id = p.id AND r.status = 'approved') AS rating,
    (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id AND r.status = 'approved') AS rating_count,
    (SELECT COALESCE(SUM(oi.qty), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE oi.product_id = p.id AND o.payment_status IN ('paid','partially_refunded') AND o.status != 'cancelled') AS sold
  FROM products p
  LEFT JOIN brands b ON b.id = p.brand_id
  LEFT JOIN categories c ON c.id = p.category_id`;

const SORTS = {
  newest: 'p.created_at DESC, p.id DESC',
  price_asc: 'min_price ASC, p.name',
  price_desc: 'min_price DESC, p.name',
  popular: 'sold DESC, p.name',
  rating: 'rating DESC, rating_count DESC, p.name',
  featured: 'p.featured DESC, p.created_at DESC'
};

function arr(v) { return v === undefined || v === '' ? [] : (Array.isArray(v) ? v : [v]).map(String).filter(Boolean); }

/**
 * f: { q, audience, category (slug), brand[], family[], concentration[], size[], min, max (GHS), inStock,
 *      flag: 'new'|'bestseller'|'featured'|'sale', sort, page, perPage }
 */
function listProducts(db, f = {}) {
  const where = ["p.status = 'active'", 'EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.active = 1)'];
  const params = [];

  if (f.q) {
    const like = `%${String(f.q).trim().replace(/[%_]/g, '')}%`;
    where.push(`(p.name LIKE ? OR b.name LIKE ? OR p.fragrance_family LIKE ? OR p.top_notes LIKE ? OR p.middle_notes LIKE ? OR p.base_notes LIKE ? OR p.description LIKE ?)`);
    params.push(like, like, like, like, like, like, like);
  }
  if (f.audience && ['men', 'women', 'unisex'].includes(f.audience)) { where.push('p.audience = ?'); params.push(f.audience); }
  if (f.category) { where.push('c.slug = ?'); params.push(f.category); }
  const brands = arr(f.brand);
  if (brands.length) { where.push(`b.slug IN (${brands.map(() => '?').join(',')})`); params.push(...brands); }
  const fam = arr(f.family);
  if (fam.length) { where.push(`p.fragrance_family IN (${fam.map(() => '?').join(',')}) COLLATE NOCASE`); params.push(...fam); }
  const conc = arr(f.concentration);
  if (conc.length) { where.push(`p.concentration IN (${conc.map(() => '?').join(',')}) COLLATE NOCASE`); params.push(...conc); }
  const sizes = arr(f.size).map(Number).filter(Number.isFinite);
  if (sizes.length) { where.push(`EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.active = 1 AND v.size_ml IN (${sizes.map(() => '?').join(',')}))`); params.push(...sizes); }

  const min = util.toPesewas(f.min), max = util.toPesewas(f.max);
  if (min !== null || max !== null) {
    let cond = 'v.product_id = p.id AND v.active = 1';
    if (min !== null) { cond += ` AND ${EFFECTIVE} >= ?`; params.push(min); }
    if (max !== null) { cond += ` AND ${EFFECTIVE} <= ?`; params.push(max); }
    where.push(`EXISTS (SELECT 1 FROM product_variants v WHERE ${cond})`);
  }
  if (f.inStock) where.push('EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.active = 1 AND v.on_hand - v.reserved > 0)');
  if (f.flag === 'new') where.push('p.is_new = 1');
  if (f.flag === 'bestseller') where.push('p.is_bestseller = 1');
  if (f.flag === 'featured') where.push('p.featured = 1');
  if (f.flag === 'sale') where.push("(EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.active = 1 AND v.discount_price IS NOT NULL AND v.discount_price < v.price) OR c.slug = 'bundles')");

  const sort = SORTS[f.sort] ? f.sort : (f.q ? 'popular' : 'featured');
  const perPage = Math.min(Math.max(parseInt(f.perPage, 10) || 12, 1), 48);
  const page = Math.max(parseInt(f.page, 10) || 1, 1);

  const whereSql = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM (${CARD_SQL} WHERE ${whereSql})`).get(...params).c;
  const rows = db.prepare(`${CARD_SQL} WHERE ${whereSql} ORDER BY ${SORTS[sort]} LIMIT ? OFFSET ?`).all(...params, perPage, (page - 1) * perPage);
  return { products: rows, total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)), sort };
}

function facets(db) {
  return {
    brands: db.prepare(`SELECT DISTINCT b.name, b.slug FROM brands b JOIN products p ON p.brand_id = b.id WHERE p.status = 'active' ORDER BY b.name`).all(),
    families: db.prepare(`SELECT DISTINCT fragrance_family AS v FROM products WHERE status = 'active' AND fragrance_family != '' ORDER BY 1`).all().map(r => r.v),
    concentrations: db.prepare(`SELECT DISTINCT concentration AS v FROM products WHERE status = 'active' AND concentration != '' ORDER BY 1`).all().map(r => r.v),
    sizes: db.prepare(`SELECT DISTINCT v.size_ml AS v FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.status = 'active' AND v.active = 1 AND v.size_ml > 0 ORDER BY 1`).all().map(r => r.v)
  };
}

function getProductBySlug(db, slug, { includeInactive = false } = {}) {
  const p = db.prepare(`${CARD_SQL} WHERE p.slug = ?`).get(slug);
  if (!p || (!includeInactive && p.status !== 'active')) return null;
  p.variants = db.prepare('SELECT * FROM product_variants WHERE product_id = ? AND active = 1 ORDER BY size_ml, id').all(p.id);
  p.images = db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY sort, id').all(p.id);
  p.reviews = db.prepare("SELECT * FROM reviews WHERE product_id = ? AND status = 'approved' ORDER BY created_at DESC LIMIT 20").all(p.id);
  return p;
}

function related(db, product, limit = 4) {
  const ids = db.prepare(`SELECT id FROM products WHERE status = 'active' AND id != ? AND (audience = ? OR brand_id = ? OR fragrance_family = ?)
    AND EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = products.id AND v.active = 1) ORDER BY RANDOM() LIMIT ?`)
    .all(product.id, product.audience, product.brand_id, product.fragrance_family, limit).map(r => r.id);
  if (!ids.length) return [];
  return db.prepare(`${CARD_SQL} WHERE p.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
}

function uniqueSlug(db, base, table = 'products', ignoreId = null) {
  let slug = util.slugify(base), n = 1;
  while (db.prepare(`SELECT id FROM ${table} WHERE slug = ? ${ignoreId ? 'AND id != ' + Number(ignoreId) : ''}`).get(slug)) {
    n++; slug = `${util.slugify(base)}-${n}`;
  }
  return slug;
}

function upsertBrand(db, name) {
  name = util.clean(name, 80);
  if (!name) return null;
  const ex = db.prepare('SELECT id FROM brands WHERE name = ? COLLATE NOCASE').get(name);
  if (ex) return ex.id;
  return Number(db.prepare('INSERT INTO brands (name, slug) VALUES (?, ?)').run(name, uniqueSlug(db, name, 'brands')).lastInsertRowid);
}

module.exports = { listProducts, facets, getProductBySlug, related, uniqueSlug, upsertBrand, CARD_SQL, EFFECTIVE };
