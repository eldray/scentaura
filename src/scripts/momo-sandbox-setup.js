'use strict';
/**
 * SANDBOX ONLY. Creates a test "API user" and "API key" at MTN so you can try Mobile Money without real money.
 * Needs MOMO_SUBSCRIPTION_KEY in .env (your Collections subscription key from momodeveloper.mtn.com).
 * For live (production) keys MTN gives you the API user and key themselves – do not use this script.
 */
const crypto = require('crypto');
const config = require('../config');

(async () => {
  const key = config.momo.subscriptionKey;
  if (!key) { console.error('Put your Collections "Primary key" in .env as MOMO_SUBSCRIPTION_KEY first.'); process.exit(1); }
  if (config.momo.env !== 'sandbox') { console.error('This only works with MOMO_ENV=sandbox.'); process.exit(1); }
  const base = config.momo.baseUrl;
  const user = crypto.randomUUID();
  let r = await fetch(`${base}/v1_0/apiuser`, {
    method: 'POST', headers: { 'X-Reference-Id': user, 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerCallbackHost: new URL(config.baseUrl).host })
  });
  if (r.status !== 201) { console.error(`Could not create the API user (${r.status}). Check the subscription key.`); process.exit(1); }
  r = await fetch(`${base}/v1_0/apiuser/${user}/apikey`, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key } });
  const j = await r.json().catch(() => null);
  if (r.status !== 201 || !j || !j.apiKey) { console.error(`Could not create the API key (${r.status}).`); process.exit(1); }
  console.log('\nAdd these two lines to your .env file, then restart the shop:\n');
  console.log(`MOMO_API_USER=${user}`);
  console.log(`MOMO_API_KEY=${j.apiKey}\n`);
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
