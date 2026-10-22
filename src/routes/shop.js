'use strict';
const express = require('express');
const catalog = require('../services/catalog');
const util = require('../lib/util');
const router = express.Router();

const db = req => req.app.locals.db;

function requireCustomer(req, res, next) {
  if (req.customer) return next();
  res.flash('info', 'Please sign in to continue.');
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

const LISTINGS = {
  '/shop': { title: 'Shop all perfumes', h1: 'All fragrances', intro: 'Browse our full collection.', base: {} },
  '/men': { title: "Men's fragrances", h1: "Men's fragrances", intro: 'Fragrances for men.', base: { audience: 'men' } },
  '/women': { title: "Women's fragrances", h1: "Women's fragrances", intro: 'Fragrances for women.', base: { audience: 'women' } },
  '/unisex': { title: 'Unisex fragrances', h1: 'Unisex fragrances', intro: 'Fragrances for everyone.', base: { audience: 'unisex' } },
  '/oils-body-sprays': { title: 'Perfume oils & body sprays', h1: 'Perfume oils & body sprays', intro: 'Perfume oils and body sprays.', base: { category: 'oils-body-sprays' } },
  '/new-arrivals': { title: 'New arrivals', h1: 'New arrivals', intro: 'The latest additions to the store.', base: { flag: 'new', sort: 'newest' } },
  '/best-sellers': { title: 'Best sellers', h1: 'Best sellers', intro: 'Our customers’ favourites.', base: { flag: 'bestseller', sort: 'popular' } },
  '/offers': { title: 'Special offers & bundles', h1: 'Special offers & bundles', intro: 'Reduced prices, gift sets and bundles.', base: { flag: 'sale' } }
};

function renderListing(req, res, cfg, extra = {}) {
  const f = { ...req.query, ...cfg.base };
  if (cfg.base.sort === undefined && req.query.sort) f.sort = req.query.sort;
  else if (cfg.base.sort && req.query.sort) f.sort = req.query.sort;
  const result = catalog.listProducts(db(req), f);
  res.page('shop', {
    title: cfg.title, description: `${cfg.intro} ${res.locals.S.business_name}.`, canonical: `${res.locals.baseUrl}${req.path}${result.page > 1 ? '?page=' + result.page : ''}`,
    heading: cfg.h1, intro: cfg.intro, result, facets: catalog.facets(db(req)), f: { ...req.query }, lockedAudience: cfg.base.audience || null,
    pathName: req.path, ...extra
  });
}

for (const [p, cfg] of Object.entries(LISTINGS)) router.get(p, (req, res) => renderListing(req, res, cfg));

router.get('/search', (req, res) => {
  const q = util.clean(req.query.q, 80);
  renderListing(req, res, { title: q ? `Search: ${q}` : 'Search', h1: q ? `Results for “${q}”` : 'Search', intro: '', base: { q } }, { noindex: true, isSearch: true });
});

router.get('/', (req, res) => {
  const d = db(req);
  const pick = (opts) => catalog.listProducts(d, { perPage: 8, ...opts }).products;
  const featured = pick({ flag: 'featured' });
  const newest = pick({ flag: 'new', sort: 'newest' });
  const best = pick({ flag: 'bestseller', sort: 'popular' });
  const fallback = featured.length || newest.length || best.length ? [] : pick({ sort: 'newest' });
  const posts = d.prepare('SELECT slug, title, excerpt FROM blog_posts WHERE published = 1 ORDER BY created_at DESC, id DESC LIMIT 3').all();
  const S = res.locals.S;
  res.page('home', {
    title: `${S.business_name} – ${S.tagline}`, description: S.default_meta_description, canonical: res.locals.baseUrl + '/',
    featured, newest, best, fallback, posts,
    jsonld: { '@context': 'https://schema.org', '@type': 'Organization', name: S.business_name, url: res.locals.baseUrl, email: S.contact_email || undefined, telephone: S.contact_phone || undefined }
  });
});

router.get('/product/:slug', (req, res) => {
  const d = db(req);
  const p = catalog.getProductBySlug(d, req.params.slug);
  if (!p) return res.status(404).page('error', { title: 'Product not found', message: 'We could not find that product.', noindex: true });
  const S = res.locals.S;
  const sellable = p.variants.filter(v => v.on_hand - v.reserved > 0);
  const url = `${res.locals.baseUrl}/product/${p.slug}`;
  const img = p.images[0] ? res.locals.baseUrl + p.images[0].path : null;
  const first = p.variants[0];
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'Product', name: p.name, description: (p.seo_description || p.description || '').slice(0, 300),
    brand: p.brand_name ? { '@type': 'Brand', name: p.brand_name } : undefined, image: p.images.map(i => res.locals.baseUrl + i.path),
    sku: first ? first.sku : undefined,
    offers: p.variants.map(v => ({ '@type': 'Offer', priceCurrency: 'GHS', price: (require('../services/pricing').effectivePrice(v) / 100).toFixed(2), sku: v.sku,
      availability: v.on_hand - v.reserved > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', url }))
  };
  if (p.rating_count > 0) jsonld.aggregateRating = { '@type': 'AggregateRating', ratingValue: p.rating, reviewCount: p.rating_count };

  let canReview = false, inWishlist = false, hasReviewed = false;
  if (req.customer) {
    canReview = !!d.prepare(`SELECT 1 FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.status = 'delivered'
      AND i.product_id = ? AND (o.customer_id = ? OR lower(o.customer_email) = lower(?)) LIMIT 1`).get(p.id, req.customer.id, req.customer.email || '');
    hasReviewed = !!d.prepare('SELECT 1 FROM reviews WHERE product_id = ? AND customer_id = ?').get(p.id, req.customer.id);
    inWishlist = !!d.prepare('SELECT 1 FROM wishlists WHERE customer_id = ? AND product_id = ?').get(req.customer.id, p.id);
  }
  const shareText = encodeURIComponent(`${p.name} – ${url}`);
  res.page('product', {
    title: p.seo_title || `${p.name}${p.brand_name ? ' by ' + p.brand_name : ''}`,
    description: p.seo_description || (p.description || S.default_meta_description).slice(0, 160),
    canonical: url, ogImage: img, ogType: 'product', jsonld, p, sellable: sellable.length > 0, related: catalog.related(d, p),
    canReview, hasReviewed, inWishlist,
    waUrl: res.locals.waLink(`Hello ${S.business_name}, I have a question about ${p.name}.`),
    share: { whatsapp: `https://wa.me/?text=${shareText}`, facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}` }
  });
});

router.post('/product/:slug/review', requireCustomer, (req, res) => {
  const d = db(req);
  const p = catalog.getProductBySlug(d, req.params.slug);
  if (!p) return res.redirect('/shop');
  const rating = util.int(req.body.rating);
  const body = util.clean(req.body.body, 1000);
  const verified = d.prepare(`SELECT 1 FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.status = 'delivered' AND i.product_id = ?
    AND (o.customer_id = ? OR lower(o.customer_email) = lower(?)) LIMIT 1`).get(p.id, req.customer.id, req.customer.email || '');
  if (!verified) res.flash('error', 'Only customers who received this product can review it.');
  else if (rating < 1 || rating > 5 || body.length < 5) res.flash('error', 'Please choose a star rating and write a short review.');
  else {
    const r = d.prepare("INSERT OR IGNORE INTO reviews (product_id, customer_id, author_name, rating, body) VALUES (?,?,?,?,?)")
      .run(p.id, req.customer.id, req.customer.name.split(' ')[0], rating, body);
    res.flash(r.changes ? 'success' : 'info', r.changes ? 'Thank you! Your review will appear once it has been approved.' : 'You have already reviewed this product.');
  }
  res.redirect(`/product/${p.slug}#reviews`);
});

router.get('/wishlist', requireCustomer, (req, res) => {
  const d = db(req);
  const ids = d.prepare('SELECT product_id FROM wishlists WHERE customer_id = ? ORDER BY created_at DESC').all(req.customer.id).map(r => r.product_id);
  const products = ids.length ? d.prepare(`${catalog.CARD_SQL} WHERE p.id IN (${ids.map(() => '?').join(',')}) AND p.status = 'active'`).all(...ids) : [];
  res.page('wishlist', { title: 'My wishlist', products, noindex: true });
});

router.post('/wishlist/toggle', requireCustomer, (req, res) => {
  const d = db(req);
  const id = util.int(req.body.productId);
  const exists = d.prepare('SELECT 1 FROM wishlists WHERE customer_id = ? AND product_id = ?').get(req.customer.id, id);
  if (exists) d.prepare('DELETE FROM wishlists WHERE customer_id = ? AND product_id = ?').run(req.customer.id, id);
  else if (d.prepare('SELECT 1 FROM products WHERE id = ?').get(id)) d.prepare('INSERT OR IGNORE INTO wishlists (customer_id, product_id) VALUES (?,?)').run(req.customer.id, id);
  const back = typeof req.body.back === 'string' && req.body.back.startsWith('/') && !req.body.back.startsWith('//') ? req.body.back : '/wishlist';
  res.redirect(back);
});

module.exports = router;
module.exports.requireCustomer = requireCustomer;
