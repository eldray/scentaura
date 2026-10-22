'use strict';
const express = require('express');
const util = require('../../lib/util');
const infra = require('../../lib/infra');
const catalog = require('../../services/catalog');
const router = express.Router();
const db = req => req.app.locals.db;

router.get('/', (req, res) => res.redirect('/admin/content/pages'));

/* ----- policy / information pages ----- */
router.get('/pages', (req, res) => res.admin('pages', { pageTitle: 'Pages & policies', pages: db(req).prepare('SELECT * FROM pages ORDER BY title').all() }));

router.get('/pages/:slug', (req, res) => {
  const p = db(req).prepare('SELECT * FROM pages WHERE slug = ?').get(req.params.slug);
  if (!p) return res.redirect('/admin/content/pages');
  res.admin('page-form', { pageTitle: `Edit: ${p.title}`, p });
});

router.post('/pages/:slug', (req, res) => {
  const d = db(req);
  const p = d.prepare('SELECT * FROM pages WHERE slug = ?').get(req.params.slug);
  if (!p) return res.redirect('/admin/content/pages');
  const approved = req.body.approved ? 1 : 0;
  d.prepare("UPDATE pages SET title = ?, body = ?, meta_title = ?, meta_description = ?, approved = ?, updated_at = datetime('now') WHERE slug = ?")
    .run(util.clean(req.body.title, 120) || p.title, String(req.body.body || '').slice(0, 30000), util.clean(req.body.meta_title, 70), util.clean(req.body.meta_description, 170), approved, p.slug);
  infra.audit(req, approved ? 'page_approved' : 'page_saved', 'page', p.slug);
  res.flash('success', approved ? 'Page saved and marked as approved.' : 'Page saved (still marked as not approved).');
  res.redirect('/admin/content/pages');
});

/* ----- FAQ ----- */
router.get('/faqs', (req, res) => res.admin('faqs', { pageTitle: 'FAQ', faqs: db(req).prepare('SELECT * FROM faqs ORDER BY sort, id').all() }));
router.post('/faqs', (req, res) => {
  const q = util.clean(req.body.question, 300), a = util.clean(req.body.answer, 2000);
  if (!q || !a) { res.flash('error', 'Enter both a question and an answer.'); return res.redirect('/admin/content/faqs'); }
  db(req).prepare('INSERT INTO faqs (question, answer, sort) VALUES (?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM faqs))').run(q, a);
  res.redirect('/admin/content/faqs');
});
router.post('/faqs/:id', (req, res) => {
  db(req).prepare('UPDATE faqs SET question = ?, answer = ?, sort = ?, active = ? WHERE id = ?').run(util.clean(req.body.question, 300), util.clean(req.body.answer, 2000), util.int(req.body.sort), req.body.active ? 1 : 0, util.int(req.params.id));
  res.flash('success', 'Saved.'); res.redirect('/admin/content/faqs');
});
router.post('/faqs/:id/delete', (req, res) => { db(req).prepare('DELETE FROM faqs WHERE id = ?').run(util.int(req.params.id)); res.redirect('/admin/content/faqs'); });

/* ----- blog ----- */
router.get('/blog', (req, res) => res.admin('blog-list', { pageTitle: 'Blog', posts: db(req).prepare('SELECT * FROM blog_posts ORDER BY created_at DESC, id DESC').all() }));
router.get('/blog/new', (req, res) => res.admin('blog-form', { pageTitle: 'New article', post: { published: 1 }, isNew: true }));
router.post('/blog', (req, res) => {
  const d = db(req);
  const title = util.clean(req.body.title, 160);
  if (title.length < 3) { res.flash('error', 'Enter a title.'); return res.redirect('/admin/content/blog/new'); }
  const id = Number(d.prepare('INSERT INTO blog_posts (slug, title, excerpt, body, meta_description, published) VALUES (?,?,?,?,?,?)')
    .run(catalog.uniqueSlug(d, title, 'blog_posts'), title, util.clean(req.body.excerpt, 300), String(req.body.body || '').slice(0, 50000), util.clean(req.body.meta_description, 170), req.body.published ? 1 : 0).lastInsertRowid);
  infra.audit(req, 'blog_created', 'blog', id, title);
  res.flash('success', 'Article saved.'); res.redirect('/admin/content/blog');
});
router.get('/blog/:id', (req, res) => {
  const post = db(req).prepare('SELECT * FROM blog_posts WHERE id = ?').get(util.int(req.params.id));
  if (!post) return res.redirect('/admin/content/blog');
  res.admin('blog-form', { pageTitle: `Edit: ${post.title}`, post, isNew: false });
});
router.post('/blog/:id', (req, res) => {
  const id = util.int(req.params.id);
  db(req).prepare('UPDATE blog_posts SET title = ?, excerpt = ?, body = ?, meta_description = ?, published = ? WHERE id = ?')
    .run(util.clean(req.body.title, 160), util.clean(req.body.excerpt, 300), String(req.body.body || '').slice(0, 50000), util.clean(req.body.meta_description, 170), req.body.published ? 1 : 0, id);
  infra.audit(req, 'blog_updated', 'blog', id);
  res.flash('success', 'Article saved.'); res.redirect('/admin/content/blog');
});
router.post('/blog/:id/delete', (req, res) => { db(req).prepare('DELETE FROM blog_posts WHERE id = ?').run(util.int(req.params.id)); infra.audit(req, 'blog_deleted', 'blog', req.params.id); res.redirect('/admin/content/blog'); });

/* ----- review moderation ----- */
router.get('/reviews', (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  res.admin('reviews', { pageTitle: 'Reviews', status, reviews: db(req).prepare('SELECT r.*, p.name AS product_name, p.slug FROM reviews r JOIN products p ON p.id = r.product_id WHERE r.status = ? ORDER BY r.id DESC LIMIT 200').all(status) });
});
router.post('/reviews/:id', (req, res) => {
  const st = ['approved', 'rejected', 'pending'].includes(req.body.status) ? req.body.status : 'pending';
  db(req).prepare('UPDATE reviews SET status = ? WHERE id = ?').run(st, util.int(req.params.id));
  infra.audit(req, 'review_' + st, 'review', req.params.id);
  res.redirect('/admin/content/reviews?status=' + (req.body.back || 'pending'));
});

module.exports = router;
