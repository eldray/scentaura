'use strict';
/** Checks that your MOMO_* values in .env are accepted by MTN (it only asks for a sign-in token; no money moves). */
const config = require('../config');
const momo = require('../services/momo');

(async () => {
  if (!config.momoEnabled()) {
    console.error('Not all MOMO_* values are set in .env (need MOMO_SUBSCRIPTION_KEY, MOMO_API_USER and MOMO_API_KEY).');
    process.exit(1);
  }
  console.log(`Mode: ${config.momo.env} | MTN address: ${config.momo.baseUrl} | currency: ${config.momo.currency}`);
  const r = await momo.client.request('POST', '/collection/token/', {
    auth: 'Basic ' + Buffer.from(`${config.momo.apiUser}:${config.momo.apiKey}`).toString('base64')
  });
  if ((r.status === 200 || r.status === 201) && r.json && r.json.access_token) console.log('OK – MTN accepted your keys.');
  else { console.error(`MTN said ${r.status}. Double-check the three values and MOMO_ENV.`); process.exit(1); }
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
