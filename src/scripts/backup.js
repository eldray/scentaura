'use strict';
/**
 * Makes a safe copy of the database (works while the shop is running).
 *   npm run backup            -> backups/scentaura-YYYY-MM-DD-HHMM.db
 * Also keeps only the newest 30 backups.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const dbm = require('../db');

(async () => {
  const dir = process.env.BACKUP_DIR || path.join(config.root, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const file = path.join(dir, `scentaura-${stamp}.db`);
  const db = dbm.get();
  await db.backup(file);
  dbm.close();
  const old = fs.readdirSync(dir).filter(f => /^scentaura-.*\.db$/.test(f)).sort().reverse().slice(30);
  old.forEach(f => fs.unlinkSync(path.join(dir, f)));
  console.log(`Backup saved: ${file}`);
  console.log('Copy this file somewhere safe that is NOT on the same server (for example Google Drive).');
})().catch(e => { console.error('Backup failed:', e.message); process.exit(1); });
