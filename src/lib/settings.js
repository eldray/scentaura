'use strict';
const dbm = require('../db');

let cache = null;
let cacheDb = null;

function all(db = dbm.get()) {
  if (cache && cacheDb === db) return cache;
  const rows = db.prepare('SELECT key, value FROM settings').all();
  cache = Object.fromEntries(rows.map(r => [r.key, r.value]));
  cacheDb = db;
  return cache;
}

function get(key, fallback = '', db = dbm.get()) {
  const v = all(db)[key];
  return v === undefined ? fallback : v;
}

function set(key, value, db = dbm.get()) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  cache = null;
}

function invalidate() { cache = null; }

module.exports = { all, get, set, invalidate };
