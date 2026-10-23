'use strict';
const express = require('express');
const router = express.Router();
const db = req => req.app.locals.db;

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

router.get('/favicon.ico', (req, res) => res.redirect(301, res.locals.S.logo_path || '/public/img/favicon.svg'));

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nDisallow: /cart\nDisallow: /checkout\nDisallow: /account\nDisallow: /order/\nDisallow: /search\nAllow: /\n\nSitemap: ${res.locals.baseUrl}/sitemap.xml\n`);
});

router.get('/sitemap.xml', (req, res) => {
  const base = res.locals.baseUrl, d = db(req);
  const urls = ['/', '/shop', '/men', '/women', '/unisex', '/oils-body-sprays', '/new-arrivals', '/best-sellers', '/offers', '/about', '/contact', '/faq', '/delivery-returns', '/authenticity', '/privacy', '/terms', '/blog', '/track']
    .map(p => ({ loc: base + p }));
  d.prepare("SELECT slug, updated_at FROM products WHERE status = 'active'").all().forEach(p => urls.push({ loc: `${base}/product/${p.slug}`, lastmod: p.updated_at.slice(0, 10) }));
  d.prepare('SELECT slug, created_at FROM blog_posts WHERE published = 1').all().forEach(p => urls.push({ loc: `${base}/blog/${p.slug}`, lastmod: p.created_at.slice(0, 10) }));
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `<url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n') + '\n</urlset>');
});

router.get('/healthz', (req, res) => {
  try { db(req).prepare('SELECT 1').get(); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false }); }
});

module.exports = router;
