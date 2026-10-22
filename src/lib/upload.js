'use strict';
/**
 * Safe image uploads: only real JPEG/PNG/WebP files are accepted (checked by content, not by name),
 * they are re-encoded with sharp (which strips hidden data), resized, and saved under random names.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const dns = require('dns');
const net = require('net');
const multer = require('multer');
const sharp = require('sharp');
const config = require('../config');
const util = require('./util');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 8 },
  fileFilter(req, file, cb) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(new Error('Only JPEG, PNG or WebP images are allowed.'));
    cb(null, true);
  }
});

async function saveImage(buffer, { maxWidth = 1400, thumbWidth = 480 } = {}) {
  const meta = await sharp(buffer).metadata();     // throws if the file is not a real image
  if (!['jpeg', 'png', 'webp'].includes(meta.format)) throw new Error('Only JPEG, PNG or WebP images are allowed.');
  if ((meta.width || 0) * (meta.height || 0) > 50e6) throw new Error('That image is too large.');
  const dir = path.join(config.uploadDir, 'products');
  fs.mkdirSync(dir, { recursive: true });
  const id = util.token(12);
  const main = `${id}.webp`, thumb = `${id}-t.webp`;
  await sharp(buffer).rotate().resize({ width: maxWidth, height: maxWidth, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(path.join(dir, main));
  await sharp(buffer).rotate().resize({ width: thumbWidth, height: thumbWidth, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toFile(path.join(dir, thumb));
  return { path: `/uploads/products/${main}`, thumb: `/uploads/products/${thumb}` };
}

/* ---------- download a photo from a web address (blocks private/internal addresses) ---------- */
const blocked = new net.BlockList();
[['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]
  .forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv4'));
[['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv6'));

function isPrivateAddress(ip) {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return blocked.check(m[1], 'ipv4');
  return blocked.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
}

/* The address is checked at connection time, so a hostname cannot be switched to an internal address afterwards. */
function safeLookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some(a => isPrivateAddress(a.address))) return cb(new Error('That address is not allowed.'));
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

const MAX_BYTES = 5 * 1024 * 1024;

function fetchImage(rawUrl, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(String(rawUrl).trim()); } catch (e) { return reject(new Error('That is not a valid web address.')); }
    if (url.protocol !== 'https:') return reject(new Error('Only https:// image addresses are allowed.'));
    if (url.port && url.port !== '443') return reject(new Error('That address is not allowed.'));
    if (url.username || url.password) return reject(new Error('That address is not allowed.'));
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) return reject(new Error('That address is not allowed.'));
    const req = https.get(url, { lookup: safeLookup, timeout: 10000, headers: { 'User-Agent': 'ScentAura-image-import', Accept: 'image/*' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects.'));
        return fetchImage(new URL(res.headers.location, url).toString(), redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`The website answered with an error (${res.statusCode}).`)); }
      if (!/^image\/(jpeg|png|webp)/i.test(res.headers['content-type'] || '')) { res.resume(); return reject(new Error('That link is not a direct JPEG, PNG or WebP image. Open the image on its own and copy that address.')); }
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > MAX_BYTES) { req.destroy(); reject(new Error('That image is bigger than 5 MB.')); } else chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('The website took too long to answer.')); });
    req.on('error', reject);
  });
}

function removeFile(publicPath) {
  if (!publicPath || !publicPath.startsWith('/uploads/')) return;
  const full = path.join(config.uploadDir, publicPath.replace('/uploads/', ''));
  if (full.startsWith(path.resolve(config.uploadDir))) fs.promises.unlink(full).catch(() => {});
}

module.exports = { upload, saveImage, removeFile, fetchImage, isPrivateAddress };
