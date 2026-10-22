'use strict';
/**
 * OPTIONAL: fills the shop with clearly-labelled DEMO products so you can try the store.
 *   npm run seed:demo      add demo products, delivery options and a test coupon
 *   npm run clear:demo     remove them again (before you add real stock)
 *
 * The demo uses made-up brands and made-up details. Do not sell these: delete them before launch.
 * Prices and delivery fees below are placeholders, NOT recommendations.
 */
const dbm = require('../db');
const catalog = require('../services/catalog');
const inventory = require('../services/inventory');

function seed(db) {
  const clear = process.argv.includes('--clear');
  if (clear) return clearDemo(db);
  if (db.prepare('SELECT COUNT(*) c FROM products WHERE is_demo = 1').get().c) { console.log('Demo products already exist.'); return; }

  const cat = slug => db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug).id;
  const items = [
    ['Demo Noir', 'Maison Demo', 'men', 'perfumes', 'Eau de Parfum', 'Woody', 'Bergamot', 'Cedar', 'Amber', [[50, 38000, 15000, 12], [100, 62000, 26000, 8]], 1, 1, 0],
    ['Demo Bloom', 'Maison Demo', 'women', 'perfumes', 'Eau de Parfum', 'Floral', 'Pear', 'Jasmine', 'Musk', [[30, 25000, 9000, 10], [50, 36000, 14000, 10], [100, 58000, 24000, 6]], 1, 0, 1],
    ['Demo Citrus Day', 'Atelier Example', 'unisex', 'perfumes', 'Eau de Toilette', 'Citrus', 'Lemon', 'Neroli', 'White musk', [[50, 24000, 8500, 20], [100, 39000, 15000, 3]], 0, 1, 0],
    ['Demo Oud Oil', 'Atelier Example', 'unisex', 'oils-body-sprays', 'Perfume oil', 'Oriental', 'Saffron', 'Rose', 'Oud', [[12, 18000, 6000, 15]], 0, 0, 1],
    ['Demo Gift Set', 'Maison Demo', 'women', 'bundles', 'Gift set', 'Floral', '', '', '', [[0, 49000, 21000, 5]], 1, 0, 0]
  ];
  db.transaction(() => {
    const uid = null;
    for (const [name, brand, aud, catSlug, conc, fam, top, mid, base, vars, featured, isNew, best] of items) {
      const brandId = catalog.upsertBrand(db, brand);
      const pid = Number(db.prepare(`INSERT INTO products (slug, name, brand_id, category_id, description, audience, concentration, fragrance_family, top_notes, middle_notes, base_notes,
        status, featured, is_new, is_bestseller, is_demo) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'active', ?,?,?, 1)`)
        .run(catalog.uniqueSlug(db, `${brand} ${name}`), name, brandId, cat(catSlug), 'DEMO PRODUCT – sample text so you can see how the store looks. Delete before launch.', aud, conc, fam, top, mid, base, featured, isNew, best).lastInsertRowid);
      for (const [ml, price, cost, qty] of vars) {
        const label = ml ? `${ml} ml` : 'Set';
        const vid = Number(db.prepare('INSERT INTO product_variants (product_id, size_ml, label, sku, price, discount_price, cost) VALUES (?,?,?,?,?,?,?)')
          .run(pid, ml, label, `DEMO-${pid}-${ml || 'SET'}`, price, name === 'Demo Citrus Day' && ml === 50 ? Math.round(price * 0.85) : null, cost).lastInsertRowid);
        db.prepare('UPDATE product_variants SET cost = ? WHERE id = ?').run(cost, vid);
        inventory.move(db, vid, { type: 'opening', onHandChange: qty, unitCost: cost, reason: 'Demo opening stock' });
      }
    }
    // Placeholder delivery options so checkout can be tried. Replace with your real fees.
    const zone = n => db.prepare('SELECT id FROM delivery_zones WHERE name = ?').get(n).id;
    if (!db.prepare('SELECT COUNT(*) c FROM delivery_rates').get().c) {
      const ins = db.prepare('INSERT INTO delivery_rates (zone_id, method, name, fee, free_over, eta_text, instructions) VALUES (?,?,?,?,?,?,?)');
      ins.run(zone('Accra & Tema'), 'standard', 'Standard delivery (DEMO fee)', 3000, 80000, '1–2 working days', null);
      ins.run(zone('Accra & Tema'), 'express', 'Express delivery (DEMO fee)', 6000, null, 'Same day', null);
      ins.run(zone('Kumasi'), 'courier', 'Courier delivery (DEMO fee)', 5000, null, '2–3 working days', null);
      ins.run(zone('Store pickup'), 'pickup', 'Collect from us', 0, null, 'Ready after confirmation', 'Pickup address: [set this in Deliveries]');
    }
    if (!db.prepare("SELECT 1 FROM coupons WHERE code = 'WELCOME10'").get()) {
      db.prepare("INSERT INTO coupons (code, description, type, value, min_spend, first_order_only, once_per_customer) VALUES ('WELCOME10','DEMO first-order code','percent',10,10000,1,1)").run();
    }
  })();
  console.log('Demo data added: 5 demo products, sample delivery options and the code WELCOME10.');
  console.log('Remove it before launch with:  npm run clear:demo');
}

function clearDemo(db) {
  const ids = db.prepare('SELECT id FROM products WHERE is_demo = 1').all().map(r => r.id);
  let removed = 0, kept = 0;
  for (const id of ids) {
    const sold = db.prepare('SELECT 1 FROM order_items WHERE product_id = ? LIMIT 1').get(id);
    if (sold) { db.prepare("UPDATE products SET status = 'archived' WHERE id = ?").run(id); kept++; }
    else { db.prepare('DELETE FROM products WHERE id = ?').run(id); removed++; }
  }
  db.prepare("DELETE FROM coupons WHERE code = 'WELCOME10' AND uses = 0").run();
  db.prepare("DELETE FROM delivery_rates WHERE name LIKE '%(DEMO fee)%' AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.rate_id = delivery_rates.id)").run();
  console.log(`Removed ${removed} demo product(s)${kept ? `; archived ${kept} that already have orders` : ''}.`);
}

if (require.main === module) { seed(dbm.get()); dbm.close(); }
module.exports = { seed, clearDemo };
