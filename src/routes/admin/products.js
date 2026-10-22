'use strict';
const express = require('express');
const catalog = require('../../services/catalog');
const inventory = require('../../services/inventory');
const util = require('../../lib/util');
const infra = require('../../lib/infra');
const { upload, saveImage, removeFile, fetchImage } = require('../../lib/upload');
const router = express.Router();

const db = req => req.app.locals.db;
const STATUSES = ['active', 'draft', 'discontinued', 'archived'];

function productInput(body) {
  const audience = ['men', 'women', 'unisex'].includes(body.audience) ? body.audience : 'unisex';
  const status = STATUSES.includes(body.status) ? body.status : 'draft';
  return {
    name: util.clean(body.name, 160), brand: util.clean(body.brand, 80), category_id: util.int(body.category_id) || null, supplier_id: util.int(body.supplier_id) || null,
    description: util.clean(body.description, 5000), audience, status,
    concentration: util.clean(body.concentration, 60), fragrance_family: util.clean(body.fragrance_family, 60),
    top_notes: util.clean(body.top_notes, 300), middle_notes: util.clean(body.middle_notes, 300), base_notes: util.clean(body.base_notes, 300),
    longevity: util.clean(body.longevity, 300), projection: util.clean(body.projection, 300), authenticity_info: util.clean(body.authenticity_info, 1000),
    featured: body.featured ? 1 : 0, is_new: body.is_new ? 1 : 0, is_bestseller: body.is_bestseller ? 1 : 0,
    seo_title: util.clean(body.seo_title, 70), seo_description: util.clean(body.seo_description, 170)
  };
}

function lookups(d) {
  return {
    categories: d.prepare('SELECT id, name FROM categories ORDER BY sort, name').all(),
    suppliers: d.prepare('SELECT id, name FROM suppliers WHERE active = 1 ORDER BY name').all(),
    brands: d.prepare('SELECT name FROM brands ORDER BY name').all().map(b => b.name)
  };
}

router.get('/', (req, res) => {
  const d = db(req);
  const q = util.clean(req.query.q, 80), status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const where = ['1=1'], params = [];
  if (q) { where.push('(p.name LIKE ? OR b.name LIKE ? OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.sku LIKE ?))'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (status) { where.push('p.status = ?'); params.push(status); } else where.push("p.status != 'archived'");
  const rows = d.prepare(`SELECT p.id, p.name, p.status, p.audience, p.is_demo, b.name AS brand,
      (SELECT thumb_path FROM product_images i WHERE i.product_id = p.id ORDER BY i.sort, i.id LIMIT 1) AS thumb,
      (SELECT COUNT(*) FROM product_variants v WHERE v.product_id = p.id) AS variants,
      (SELECT COALESCE(SUM(on_hand),0) FROM product_variants v WHERE v.product_id = p.id) AS on_hand,
      (SELECT COALESCE(SUM(reserved),0) FROM product_variants v WHERE v.product_id = p.id) AS reserved,
      (SELECT MIN(price) FROM product_variants v WHERE v.product_id = p.id) AS min_price
    FROM products p LEFT JOIN brands b ON b.id = p.brand_id WHERE ${where.join(' AND ')} ORDER BY p.updated_at DESC LIMIT 300`).all(...params);
  res.admin('products', { pageTitle: 'Products', rows, q, status, STATUSES, demoCount: d.prepare('SELECT COUNT(*) c FROM products WHERE is_demo = 1').get().c });
});

/** Saves uploaded files and/or photos fetched from web addresses. Returns { added, problems[] }. */
async function addPhotos(d, productId, productName, body, files) {
  const alt = util.clean(body.alt, 200) || productName;
  const urls = String(body.imageUrls || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 8);
  const jobs = [...(files || []).map(f => ({ label: f.originalname || 'file', get: async () => f.buffer })), ...urls.map(u => ({ label: u, get: () => fetchImage(u) }))];
  let added = 0; const problems = [];
  for (const j of jobs) {
    try {
      const saved = await saveImage(await j.get());
      const sort = d.prepare('SELECT COALESCE(MAX(sort),0)+1 n FROM product_images WHERE product_id = ?').get(productId).n;
      d.prepare('INSERT INTO product_images (product_id, path, thumb_path, alt, sort) VALUES (?,?,?,?,?)').run(productId, saved.path, saved.thumb, alt, sort);
      added++;
    } catch (e) { problems.push(`${String(j.label).slice(0, 60)}: ${e.message}`); }
  }
  return { added, problems };
}

router.get('/new', (req, res) => res.admin('product-form', { pageTitle: 'Add product', p: { status: 'draft', audience: 'unisex', variants: [], images: [] }, isNew: true, ...lookups(db(req)), errors: [], STATUSES }));

router.post('/new', (req, res, next) => upload.array('images', 8)(req, res, err => {
  if (err) { res.flash('error', err.message); return res.redirect('/admin/products/new'); }
  next();
}), async (req, res) => {
  const d = db(req);
  const v = productInput(req.body);
  if (v.name.length < 2) return res.status(400).admin('product-form', { pageTitle: 'Add product', p: { ...v, brand_name: v.brand, variants: [], images: [] }, isNew: true, ...lookups(d), errors: ['Please enter the product name.'], STATUSES });
  const id = d.transaction(() => {
    const brandId = catalog.upsertBrand(d, v.brand);
    const info = d.prepare(`INSERT INTO products (slug, name, brand_id, category_id, supplier_id, description, audience, concentration, fragrance_family, top_notes, middle_notes, base_notes,
        longevity, projection, authenticity_info, status, featured, is_new, is_bestseller, seo_title, seo_description)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(catalog.uniqueSlug(d, v.brand ? `${v.brand} ${v.name}` : v.name), v.name, brandId, v.category_id, v.supplier_id, v.description, v.audience, v.concentration,
      v.fragrance_family, v.top_notes, v.middle_notes, v.base_notes, v.longevity, v.projection, v.authenticity_info, v.status, v.featured, v.is_new, v.is_bestseller, v.seo_title, v.seo_description);
    return Number(info.lastInsertRowid);
  })();
  infra.audit(req, 'product_created', 'product', id, v.name);
  const ph = await addPhotos(d, id, v.name, req.body, req.files);
  if (ph.added) infra.audit(req, 'images_added', 'product', id, String(ph.added));
  if (ph.problems.length) res.flash('error', 'Product saved, but some photos could not be added: ' + ph.problems.join(' | '));
  else res.flash('success', ph.added ? `Product saved with ${ph.added} photo${ph.added > 1 ? 's' : ''}. Now add at least one size with its price below.` : 'Product saved. Now add at least one size with its price below, and some photos.');
  res.redirect(`/admin/products/${id}/edit`);
});

function loadProduct(d, id) {
  const p = d.prepare('SELECT p.*, b.name AS brand_name FROM products p LEFT JOIN brands b ON b.id = p.brand_id WHERE p.id = ?').get(id);
  if (!p) return null;
  p.variants = d.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY size_ml, id').all(id);
  p.images = d.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY sort, id').all(id);
  return p;
}

router.get('/:id/edit', (req, res) => {
  const d = db(req);
  const p = loadProduct(d, util.int(req.params.id));
  if (!p) return res.status(404).admin('forbidden', { pageTitle: 'Not found' });
  res.admin('product-form', { pageTitle: `Edit ${p.name}`, p, isNew: false, ...lookups(d), errors: [], STATUSES, canCost: infra.can(req.staff.role, 'reports') || infra.can(req.staff.role, 'inventory') });
});

router.post('/:id', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  const old = d.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!old) return res.redirect('/admin/products');
  const v = productInput(req.body);
  if (v.name.length < 2) { res.flash('error', 'Product name is required.'); return res.redirect(`/admin/products/${id}/edit`); }
  if (v.status === 'active' && !d.prepare('SELECT 1 FROM product_variants WHERE product_id = ? AND active = 1').get(id)) {
    v.status = 'draft'; res.flash('info', 'Add at least one size before making a product active, so it was saved as a draft.');
  }
  d.transaction(() => {
    const brandId = catalog.upsertBrand(d, v.brand);
    d.prepare(`UPDATE products SET name=?, brand_id=?, category_id=?, supplier_id=?, description=?, audience=?, concentration=?, fragrance_family=?, top_notes=?, middle_notes=?, base_notes=?,
      longevity=?, projection=?, authenticity_info=?, status=?, featured=?, is_new=?, is_bestseller=?, seo_title=?, seo_description=?, updated_at=datetime('now') WHERE id=?`)
      .run(v.name, brandId, v.category_id, v.supplier_id, v.description, v.audience, v.concentration, v.fragrance_family, v.top_notes, v.middle_notes, v.base_notes, v.longevity, v.projection,
        v.authenticity_info, v.status, v.featured, v.is_new, v.is_bestseller, v.seo_title, v.seo_description, id);
  })();
  infra.audit(req, 'product_updated', 'product', id, v.name + (old.status !== v.status ? ` (status ${old.status} → ${v.status})` : ''));
  if (!req.session.flash) res.flash('success', 'Product saved.');
  res.redirect(`/admin/products/${id}/edit`);
});

router.post('/:id/duplicate', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  const p = d.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!p) return res.redirect('/admin/products');
  const newId = d.transaction(() => {
    const copyName = `${p.name} (copy)`;
    const info = d.prepare(`INSERT INTO products (slug, name, brand_id, category_id, supplier_id, description, audience, concentration, fragrance_family, top_notes, middle_notes, base_notes,
      longevity, projection, authenticity_info, status, featured, is_new, is_bestseller, seo_title, seo_description)
      SELECT ?, ?, brand_id, category_id, supplier_id, description, audience, concentration, fragrance_family, top_notes, middle_notes, base_notes, longevity, projection, authenticity_info,
      'draft', 0, 0, 0, seo_title, seo_description FROM products WHERE id = ?`).run(catalog.uniqueSlug(d, copyName), copyName, id);
    return Number(info.lastInsertRowid);
  })();
  infra.audit(req, 'product_duplicated', 'product', newId, `from ${id}`);
  res.flash('success', 'Copied as a draft. Add sizes and photos, then make it active. (Stock and photos are not copied.)');
  res.redirect(`/admin/products/${newId}/edit`);
});

router.post('/:id/archive', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  d.prepare("UPDATE products SET status = 'archived', updated_at = datetime('now') WHERE id = ?").run(id);
  infra.audit(req, 'product_archived', 'product', id);
  res.flash('success', 'Product archived. It is hidden from the shop but its history is kept.');
  res.redirect('/admin/products');
});

router.post('/:id/delete', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  if (d.prepare('SELECT 1 FROM order_items WHERE product_id = ? LIMIT 1').get(id) || d.prepare('SELECT 1 FROM purchase_items pi JOIN product_variants v ON v.id = pi.variant_id WHERE v.product_id = ? LIMIT 1').get(id)) {
    res.flash('error', 'This product has orders or purchases, so it cannot be deleted. Archive it instead.');
    return res.redirect(`/admin/products/${id}/edit`);
  }
  const imgs = d.prepare('SELECT path, thumb_path FROM product_images WHERE product_id = ?').all(id);
  const p = d.prepare('SELECT name FROM products WHERE id = ?').get(id);
  d.prepare('DELETE FROM products WHERE id = ?').run(id);
  imgs.forEach(i => { removeFile(i.path); removeFile(i.thumb_path); });
  infra.audit(req, 'product_deleted', 'product', id, p && p.name);
  res.flash('success', 'Product deleted.');
  res.redirect('/admin/products');
});

/* ---------- sizes / variants ---------- */
function variantInput(body) {
  const size = util.int(body.size_ml);
  const price = util.toPesewas(body.price);
  const disc = body.discount_price === '' || body.discount_price === undefined ? null : util.toPesewas(body.discount_price);
  const cost = body.cost === '' || body.cost === undefined ? 0 : util.toPesewas(body.cost);
  return { size, label: util.clean(body.label, 40) || (size ? `${size} ml` : ''), price, disc, cost, sku: util.clean(body.sku, 40).toUpperCase().replace(/[^A-Z0-9\-_.]/g, ''), barcode: util.clean(body.barcode, 40) || null,
    threshold: Math.max(0, util.int(body.low_stock_threshold, 5)), qty: Math.max(0, util.int(body.opening_qty)) };
}

router.post('/:id/variants', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  const p = d.prepare('SELECT id, name FROM products WHERE id = ?').get(id);
  if (!p) return res.redirect('/admin/products');
  const v = variantInput(req.body);
  const back = `/admin/products/${id}/edit#sizes`;
  if (!v.label) { res.flash('error', 'Enter the size, for example 100.'); return res.redirect(back); }
  if (v.price === null || v.price <= 0) { res.flash('error', 'Enter a selling price greater than zero, for example 450.00.'); return res.redirect(back); }
  if (v.disc !== null && v.disc >= v.price) { res.flash('error', 'The discount price must be lower than the normal price (or leave it empty).'); return res.redirect(back); }
  if (v.cost === null) { res.flash('error', 'The purchase cost is not a valid amount.'); return res.redirect(back); }
  const sku = v.sku || `SA-${p.id}-${v.size || v.label.replace(/\W/g, '')}`.toUpperCase();
  try {
    d.transaction(() => {
      const vid = Number(d.prepare(`INSERT INTO product_variants (product_id, size_ml, label, sku, barcode, price, discount_price, cost, low_stock_threshold) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, v.size, v.label, sku, v.barcode, v.price, v.disc, v.cost, v.threshold).lastInsertRowid);
      if (v.qty > 0) inventory.setOpeningStock(d, vid, v.qty, v.cost, req.staff.id);
    })();
    infra.audit(req, 'variant_created', 'product', id, `${v.label} @ ${v.price}`);
    res.flash('success', 'Size added.');
  } catch (e) {
    res.flash('error', /UNIQUE/.test(e.message) ? 'That SKU is already used by another size. Choose a different one.' : 'Could not save the size.');
  }
  res.redirect(back);
});

router.post('/:id/variants/:vid', (req, res) => {
  const d = db(req), id = util.int(req.params.id), vid = util.int(req.params.vid);
  const old = d.prepare('SELECT * FROM product_variants WHERE id = ? AND product_id = ?').get(vid, id);
  const back = `/admin/products/${id}/edit#sizes`;
  if (!old) return res.redirect(back);
  const v = variantInput({ ...req.body, label: req.body.label || old.label });
  if (v.price === null || v.price <= 0 || (v.disc !== null && (v.disc >= v.price)) || v.cost === null) {
    res.flash('error', 'Check the prices: the selling price must be above zero and a discount price must be lower than it.'); return res.redirect(back);
  }
  try {
    d.prepare(`UPDATE product_variants SET size_ml=?, label=?, sku=?, barcode=?, price=?, discount_price=?, low_stock_threshold=?, active=? ${req.body.cost !== undefined && req.body.cost !== '' ? ', cost=' + Number(v.cost) : ''} WHERE id=?`)
      .run(v.size, v.label, v.sku || old.sku, v.barcode, v.price, v.disc, v.threshold, req.body.active ? 1 : 0, vid);
    d.prepare("UPDATE products SET updated_at = datetime('now') WHERE id = ?").run(id);
    infra.audit(req, 'variant_updated', 'variant', vid, `price ${old.price}→${v.price}, discount ${old.discount_price}→${v.disc}`);
    res.flash('success', 'Size updated.');
  } catch (e) { res.flash('error', /UNIQUE/.test(e.message) ? 'That SKU is already in use.' : 'Could not save the size.'); }
  res.redirect(back);
});

router.post('/:id/variants/:vid/delete', (req, res) => {
  const d = db(req), id = util.int(req.params.id), vid = util.int(req.params.vid);
  const v = d.prepare('SELECT * FROM product_variants WHERE id = ? AND product_id = ?').get(vid, id);
  if (v) {
    const used = d.prepare('SELECT 1 FROM order_items WHERE variant_id = ? LIMIT 1').get(vid) || d.prepare('SELECT 1 FROM purchase_items WHERE variant_id = ? LIMIT 1').get(vid) || v.on_hand > 0;
    if (used) { d.prepare('UPDATE product_variants SET active = 0 WHERE id = ?').run(vid); res.flash('info', 'This size has stock or history, so it was switched off instead of deleted.'); }
    else { d.prepare('DELETE FROM product_variants WHERE id = ?').run(vid); res.flash('success', 'Size deleted.'); }
    infra.audit(req, 'variant_removed', 'variant', vid);
  }
  res.redirect(`/admin/products/${id}/edit#sizes`);
});

/* ---------- photos (CSRF token travels in the URL because the form is multipart) ---------- */
router.post('/:id/images', (req, res, next) => upload.array('images', 8)(req, res, err => {
  if (err) { res.flash('error', err.message); return res.redirect(`/admin/products/${req.params.id}/edit#photos`); }
  next();
}), async (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  const p = d.prepare('SELECT id, name FROM products WHERE id = ?').get(id);
  if (!p) return res.redirect('/admin/products');
  const ph = await addPhotos(d, id, p.name, req.body, req.files);
  if (ph.added) { res.flash('success', `${ph.added} photo${ph.added > 1 ? 's' : ''} added.`); infra.audit(req, 'images_added', 'product', id, String(ph.added)); }
  if (ph.problems.length) res.flash('error', 'Could not add: ' + ph.problems.join(' | '));
  if (!ph.added && !ph.problems.length) res.flash('error', 'Choose a photo file or paste an image address first.');
  res.redirect(`/admin/products/${id}/edit#photos`);
});

router.post('/:id/images/:imgId/main', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  const min = d.prepare('SELECT COALESCE(MIN(sort),0) m FROM product_images WHERE product_id = ?').get(id).m;
  d.prepare('UPDATE product_images SET sort = ? WHERE id = ? AND product_id = ?').run(min - 1, util.int(req.params.imgId), id);
  res.redirect(`/admin/products/${id}/edit#photos`);
});

router.post('/:id/images/:imgId/alt', (req, res) => {
  const id = util.int(req.params.id);
  db(req).prepare('UPDATE product_images SET alt = ? WHERE id = ? AND product_id = ?').run(util.clean(req.body.alt, 200), util.int(req.params.imgId), id);
  res.redirect(`/admin/products/${id}/edit#photos`);
});

router.post('/:id/images/:imgId/delete', (req, res) => {
  const d = db(req), id = util.int(req.params.id);
  const img = d.prepare('SELECT * FROM product_images WHERE id = ? AND product_id = ?').get(util.int(req.params.imgId), id);
  if (img) { d.prepare('DELETE FROM product_images WHERE id = ?').run(img.id); removeFile(img.path); removeFile(img.thumb_path); }
  res.redirect(`/admin/products/${id}/edit#photos`);
});

module.exports = router;
