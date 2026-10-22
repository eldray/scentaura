'use strict';
const fs = require('fs');
const config = require('./config');
const dbm = require('./db');

if (config.isProd) config.assertProduction();
fs.mkdirSync(config.uploadDir, { recursive: true });

const db = dbm.get();
const { createApp } = require('./app');
const orders = require('./services/orders');
const app = createApp(db);

const server = app.listen(config.port, () => {
  console.log(`ScentAura is running at ${config.baseUrl}  (port ${config.port})`);
  if (!config.paystackEnabled()) console.log('Note: PAYSTACK_SECRET_KEY is not set, so online payment is switched off.');
  if (!config.isProd && !config.sessionSecret) console.log('Note: using a built-in development session secret. Set SESSION_SECRET before going live.');
  const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (!users) console.log('No staff account yet. Create the owner with:  npm run create-admin');
});

// Housekeeping every 5 minutes: free stock held by unpaid orders, and clear old sessions.
const timer = setInterval(() => {
  try {
    const n = orders.expireStaleOrders(db);
    if (n) console.log(`Released ${n} unpaid order(s).`);
    app.get('sessionStore').cleanup();
  } catch (e) { console.error('housekeeping failed', e.message); }
}, 5 * 60 * 1000);
timer.unref();

function shutdown() {
  console.log('Shutting down…');
  clearInterval(timer);
  server.close(() => { dbm.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
