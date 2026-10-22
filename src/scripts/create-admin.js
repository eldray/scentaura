'use strict';
/**
 * Creates the first Owner account from the command line.
 *   npm run create-admin
 * The password is typed in the terminal (hidden) and is never stored in a file.
 */
const readline = require('readline');
const bcrypt = require('bcryptjs');
const dbm = require('../db');
const util = require('../lib/util');

function ask(rl, q, hidden) {
  return new Promise(resolve => {
    if (!hidden || !process.stdin.isTTY) return rl.question(q, resolve);
    const out = rl.output;
    const orig = rl._writeToOutput;
    rl._writeToOutput = s => { if (s.includes(q)) out.write(s); else out.write(''); };
    rl.question(q, a => { rl._writeToOutput = orig; out.write('\n'); resolve(a); });
  });
}

(async () => {
  const db = dbm.get();
  const existing = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  if (!process.stdin.isTTY) console.log('Note: this terminal cannot hide typing, so the password will be visible. Use PowerShell or run "winpty npm run create-admin" to hide it.');
  console.log(existing ? `There are already ${existing} staff account(s). You can add another owner.` : 'Creating the first Owner account.');
  const name = (await ask(rl, 'Your name: ')).trim();
  const email = (await ask(rl, 'Your email: ')).trim().toLowerCase();
  const pw = await ask(rl, 'Password (at least 10 characters, hidden): ', true);
  const pw2 = await ask(rl, 'Type the password again: ', true);
  rl.close();
  if (name.length < 2) throw new Error('Please enter your name.');
  if (!util.isEmail(email)) throw new Error('That email address does not look right.');
  if (pw.length < 10) throw new Error('The password must be at least 10 characters.');
  if (pw !== pw2) throw new Error('The two passwords did not match.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(email)) throw new Error('That email already has an account.');
  const id = db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?, 'owner')").run(email, name, bcrypt.hashSync(pw, 12)).lastInsertRowid;
  db.prepare("INSERT INTO audit_logs (action, entity, entity_id, user_label, detail) VALUES ('owner_created','user',?, 'command line', ?)").run(String(id), email);
  console.log(`\nDone. Sign in at /admin/login with ${email}`);
  dbm.close();
})().catch(e => { console.error('\nCould not create the account: ' + e.message); process.exit(1); });
