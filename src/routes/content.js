'use strict';
const express = require('express');
const router = express.Router();
const db = req => req.app.locals.db;

function pageRoute(path, slug, extra) {
  router.get(path, (req, res) => {
    const p = db(req).prepare('SELECT * FROM pages WHERE slug = ?').get(slug);
    if (!p) return res.status(404).page('error', { title: 'Page not found', message: 'We could not find that page.', noindex: true });
    res.page('page', {
      title: p.meta_title || p.title, description: p.meta_description || '', canonical: `${res.locals.baseUrl}${path}`,
      p, ...(extra ? extra(req, res) : {})
    });
  });
}

pageRoute('/about', 'about');
pageRoute('/contact', 'contact', (req, res) => ({ showContact: true }));
pageRoute('/delivery-returns', 'delivery-returns', (req) => ({
  zones: db(req).prepare(`SELECT z.name, r.name AS rate, r.fee, r.free_over, r.eta_text FROM delivery_zones z JOIN delivery_rates r ON r.zone_id = z.id
    WHERE z.active = 1 AND r.active = 1 ORDER BY z.sort, z.name, r.fee`).all()
}));
pageRoute('/authenticity', 'authenticity');
pageRoute('/privacy', 'privacy');
pageRoute('/terms', 'terms');

router.get('/faq', (req, res) => {
  const faqs = db(req).prepare('SELECT * FROM faqs WHERE active = 1 ORDER BY sort, id').all();
  res.page('faq', {
    title: 'Frequently asked questions', description: 'Answers to common questions about ordering, payment and delivery.', canonical: `${res.locals.baseUrl}/faq`, faqs,
    jsonld: faqs.length ? { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqs.map(f => ({ '@type': 'Question', name: f.question, acceptedAnswer: { '@type': 'Answer', text: f.answer } })) } : null
  });
});

router.get('/blog', (req, res) => {
  const posts = db(req).prepare('SELECT slug, title, excerpt, created_at FROM blog_posts WHERE published = 1 ORDER BY created_at DESC, id DESC').all();
  res.page('blog', { title: 'Fragrance guides & articles', description: 'Practical guides to choosing, wearing and storing perfume.', canonical: `${res.locals.baseUrl}/blog`, posts });
});

router.get('/blog/:slug', (req, res) => {
  const post = db(req).prepare('SELECT * FROM blog_posts WHERE slug = ? AND published = 1').get(req.params.slug);
  if (!post) return res.status(404).page('error', { title: 'Article not found', message: 'We could not find that article.', noindex: true });
  const url = `${res.locals.baseUrl}/blog/${post.slug}`;
  res.page('post', {
    title: post.title, description: post.meta_description || post.excerpt, canonical: url, post, ogType: 'article',
    jsonld: { '@context': 'https://schema.org', '@type': 'Article', headline: post.title, datePublished: post.created_at.replace(' ', 'T') + 'Z', publisher: { '@type': 'Organization', name: res.locals.S.business_name } },
    share: { whatsapp: `https://wa.me/?text=${encodeURIComponent(post.title + ' – ' + url)}`, facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}` }
  });
});

module.exports = router;
