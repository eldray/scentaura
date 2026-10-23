'use strict';
const express = require('express');
const config = require('../../config');
const settings = require('../../lib/settings');
const util = require('../../lib/util');
const infra = require('../../lib/infra');
const { upload, saveImage, removeFile } = require('../../lib/upload');
const router = express.Router();
const db = req => req.app.locals.db;

const TEXT_KEYS = ['business_name', 'tagline', 'hero_title', 'hero_subtitle', 'announcement', 'contact_email', 'contact_phone', 'address', 'opening_hours', 'currency_symbol',
  'cod_label', 'order_notify_email', 'default_meta_description', 'trust_authentic', 'trust_delivery', 'trust_payment', 'trust_support', 'facebook_url', 'instagram_url', 'tiktok_url', 'plausible_domain', 'ga_measurement_id'];

router.get('/', (req, res) => {
  res.admin('settings', {
    pageTitle: 'Settings',
    system: { momo: config.momoEnabled(), momoEnv: config.momo.env, paystack: config.paystackEnabled(), paystackTest: /^sk_test_/.test(config.paystack.secretKey), smtp: !!config.smtp.host, baseUrl: config.baseUrl, prod: config.isProd }
  });
});

router.post('/', (req, res) => {
  const d = db(req), b = req.body;
  d.transaction(() => {
    for (const k of TEXT_KEYS) if (b[k] !== undefined) settings.set(k, util.clean(b[k], 400), d);
    const wa = String(b.whatsapp_number || '').replace(/\D/g, '');
    settings.set('whatsapp_number', /^0\d{9}$/.test(wa) ? '233' + wa.slice(1) : wa, d);
    settings.set('cod_enabled', b.cod_enabled ? '1' : '0', d);
    settings.set('reservation_minutes', String(Math.min(1440, Math.max(15, util.int(b.reservation_minutes, 120)))), d);
    settings.set('referral_discount_percent', String(Math.min(50, Math.max(0, util.int(b.referral_discount_percent, 0)))), d);
    const map = String(b.map_embed_url || '').trim();
    settings.set('map_embed_url', /^https:\/\/www\.google\.com\/maps\/embed\?/.test(map) ? map : '', d);
  })();
  infra.audit(req, 'settings_updated', 'settings');
  res.flash('success', 'Settings saved.');
  res.redirect('/admin/settings');
});

/* logo / hero image (multipart: CSRF token is in the URL) */
const IMAGE_KEYS = { logo: 'logo_path', hero: 'hero_image', 'cat-women': 'cat_img_women', 'cat-men': 'cat_img_men', 'cat-unisex': 'cat_img_unisex', 'cat-new': 'cat_img_new', 'cat-best': 'cat_img_best' };

router.post('/image/:which', (req, res, next) => upload.single('image')(req, res, err => {
  if (err) { res.flash('error', err.message); return res.redirect('/admin/settings'); }
  next();
}), async (req, res) => {
  const key = IMAGE_KEYS[req.params.which] || null;
  if (!key || !req.file) { res.flash('error', 'Choose an image first.'); return res.redirect('/admin/settings'); }
  try {
    const saved = await saveImage(req.file.buffer, { maxWidth: key === 'logo_path' ? 600 : key.startsWith('cat_img') ? 900 : 2000 });
    removeFile(settings.get(key, '', db(req)));
    settings.set(key, saved.path, db(req));
    infra.audit(req, 'settings_image', 'settings', key);
    res.flash('success', 'Image updated.');
  } catch (e) { res.flash('error', 'That file is not a valid image.'); }
  res.redirect('/admin/settings');
});

router.post('/image/:which/remove', (req, res) => {
  const key = IMAGE_KEYS[req.params.which] || null;
  if (key) { removeFile(settings.get(key, '', db(req))); settings.set(key, '', db(req)); }
  res.redirect('/admin/settings');
});

router.get('/audit', (req, res) => {
  const page = Math.max(1, util.int(req.query.page, 1));
  const rows = db(req).prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100 OFFSET ?').all((page - 1) * 100);
  res.admin('audit', { pageTitle: 'Activity log', rows, page });
});

router.get('/outbox', (req, res) => {
  res.admin('outbox', { pageTitle: 'Email outbox', rows: db(req).prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 100').all(), smtp: !!config.smtp.host });
});

module.exports = router;
