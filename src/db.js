'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');   // built into Node 22.13+ and 24: nothing to compile
const config = require('./config');

let db = null;

/**
 * Thin wrapper so the rest of the app can use the familiar prepare/run/get/all,
 * pragma(), transaction() and backup() calls on top of Node's built-in SQLite.
 */
class Conn {
  constructor(target) {
    this.raw = new DatabaseSync(target);
    this.depth = 0;
    this.cache = new Map();
  }
  exec(sql) { return this.raw.exec(sql); }
  prepare(sql) {
    let st = this.cache.get(sql);
    if (!st) { st = this.raw.prepare(sql); this.cache.set(sql, st); }
    const clean = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
    return {
      run: (...a) => { const r = st.run(...clean(a)); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
      get: (...a) => { const r = st.get(...clean(a)); return r ? { ...r } : r; },
      all: (...a) => st.all(...clean(a)).map(r => ({ ...r }))
    };
  }
  pragma(text) { return this.raw.prepare('PRAGMA ' + text).all(); }
  transaction(fn) {
    return (...args) => {
      const outer = this.depth === 0, name = 'sp' + this.depth;
      this.raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
      this.depth++;
      try {
        const r = fn(...args);
        this.depth--;
        this.raw.exec(outer ? 'COMMIT' : `RELEASE ${name}`);
        return r;
      } catch (e) {
        this.depth--;
        try { this.raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`); } catch (_) { /* already rolled back */ }
        throw e;
      }
    };
  }
  async backup(file) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    this.raw.exec(`VACUUM INTO '${String(file).replace(/'/g, "''")}'`);
  }
  close() { this.raw.close(); }
}

function open(file) {
  const target = file || config.dbPath;
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  const conn = new Conn(target);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');
  return conn;
}

function migrate(conn) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  conn.exec(sql);
  require('./lib/defaults').seedDefaults(conn);
  return conn;
}

/** Shared connection used by the running app. */
function get() {
  if (!db) db = migrate(open());
  return db;
}

/** Fresh isolated database (used by automated tests). */
function memory() {
  return migrate(open(':memory:'));
}

function close() {
  if (db) { db.close(); db = null; }
}

/** Run fn inside a transaction on the given connection. */
function tx(conn, fn) {
  return conn.transaction(fn)();
}

module.exports = { get, memory, close, open, migrate, tx };
