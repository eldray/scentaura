'use strict';
/**
 * First-run defaults. Everything here is a starting point the owner edits in the dashboard.
 * Nothing here invents products, prices, delivery fees, legal promises or reviews.
 */

const SETTINGS = {
  business_name: 'ScentAura',
  tagline: 'Fragrances for every moment',
  logo_path: '',
  hero_title: 'Luxury fragrances for every moment',
  hero_subtitle: 'Browse our collection and have it delivered across Ghana.',
  hero_image: '',
  cat_img_women: '', cat_img_men: '', cat_img_unisex: '', cat_img_new: '', cat_img_best: '',
  announcement: '',
  contact_email: '',
  contact_phone: '',
  whatsapp_number: '',          // digits only, international, e.g. 233241234567
  address: '',
  opening_hours: '',
  map_embed_url: '',
  facebook_url: '',
  instagram_url: '',
  tiktok_url: '',
  currency_symbol: 'GHS',
  cod_enabled: '0',
  cod_label: 'Pay on delivery / pickup',
  reservation_minutes: '120',
  referral_discount_percent: '5',
  order_notify_email: '',
  plausible_domain: '',
  ga_measurement_id: '',
  default_meta_description: 'Shop perfumes online in Ghana with delivery nationwide.',
  trust_authentic: 'Sourced from suppliers we can name',
  trust_delivery: 'Delivery across Ghana',
  trust_payment: 'Pay with Mobile Money or card',
  trust_support: 'Help on WhatsApp'
};

const CATEGORIES = [
  ['Perfumes', 'perfumes', 1],
  ['Perfume Oils & Body Sprays', 'oils-body-sprays', 2],
  ['Gift Sets & Bundles', 'bundles', 3]
];

const ZONES = [
  ['Accra & Tema', 'Greater Accra region including Tema'],
  ['Kumasi', 'Kumasi and nearby areas'],
  ['Tamale', 'Tamale and nearby areas'],
  ['Other regional capitals', 'Takoradi, Cape Coast, Ho, Sunyani, Koforidua, Bolgatanga, Wa and similar'],
  ['Other towns & districts', 'Delivered through a courier or bus-station dispatch'],
  ['Store pickup', 'Collect your order yourself']
];

const EXPENSE_CATEGORIES = ['Stock purchases', 'Packaging', 'Delivery costs', 'Advertising', 'Website hosting & domain', 'Payment-processing charges', 'Staff costs', 'Rent & utilities', 'Photography', 'Registration & licences', 'Other'];

const TODO = '[OWNER: replace this with your own details before launch]';

const PAGES = [
  ['about', 'About us',
    `Welcome to the store. ${TODO}\n\nTell customers who you are, where you are based, how you source your fragrances and why you started. Only state things you can prove, for example name your suppliers or authorised distributors if you are allowed to.`,
    'About us', 'Who we are and how we source our fragrances.'],
  ['contact', 'Contact us',
    `We are happy to help with product questions, orders and delivery. Use the details shown on this page or send us a message on WhatsApp.\n\n${TODO}`,
    'Contact us', 'Contact the store by phone, email or WhatsApp.'],
  ['delivery-returns', 'Delivery & returns',
    `DRAFT – the owner must edit and approve this page before launch.\n\nDelivery\nWe deliver to the zones and prices shown at checkout. Delivery times shown are estimates and can be affected by traffic, weather, courier delays and public holidays. ${TODO}\n\nChecking your order\nPlease check your parcel when it arrives. If an item is damaged or incorrect, contact us within [NUMBER] days with your order number and photos. ${TODO}\n\nReturns and refunds\nFragrances are personal-care products. State clearly which items can be returned (for example unopened and sealed), within how many days, and who pays the return delivery. ${TODO}\n\nCancellations\nState when an order can still be cancelled (for example before dispatch). ${TODO}`,
    'Delivery & returns', 'Delivery times, charges, returns and refunds.'],
  ['authenticity', 'Product authenticity',
    `DRAFT – the owner must edit and approve this page before launch.\n\nOnly describe your sourcing in ways you can prove. For example: the names of your suppliers, whether they are authorised distributors, and that you keep supplier invoices for the stock you sell. Do not say "100% original" unless your supplier documents back it up. ${TODO}`,
    'Product authenticity', 'How we source and verify our fragrances.'],
  ['privacy', 'Privacy policy',
    `DRAFT – the owner should have this reviewed against Ghana's Data Protection Act, 2012 (Act 843) and register with the Data Protection Commission if required.\n\nWhat we collect\nWe collect only what we need to take and deliver your order: your name, telephone number, email address and delivery address. If you create an account we also store your password in a protected (hashed) form.\n\nWhy we collect it\nTo process payments, deliver orders, send order updates and answer your questions. We send marketing messages only if you tick the consent box, and you can withdraw consent at any time.\n\nPayments\nMobile Money and card payments are handled by our payment provider (MTN Mobile Money and, where offered, Paystack). We never see or store your card number or Mobile Money PIN.\n\nSharing\nWe share your delivery details with the courier delivering your order and with our payment provider. We do not sell your data.\n\nYour rights\nYou may ask to see, correct or delete your personal information by contacting us. ${TODO}`,
    'Privacy policy', 'How we collect, use and protect your personal information.'],
  ['terms', 'Terms & conditions',
    `DRAFT – the owner should have this reviewed by a lawyer before launch.\n\nOrders\nAn order is accepted once payment is confirmed (or, for pay-on-delivery orders, once we confirm it). Prices are shown in Ghana cedis. We may cancel and refund an order if an item is out of stock or a price was shown in error.\n\nPayment\nOnline payments are processed through MTN Mobile Money (or Paystack for cards where offered). Orders paid on delivery must be paid in full when the parcel is handed over.\n\nDelivery, returns and refunds\nSee our Delivery & returns page.\n\nContact\n${TODO}`,
    'Terms & conditions', 'The terms that apply when you shop with us.']
];

const FAQS = [
  ['How do I place an order?', 'Choose your fragrance and size, add it to your cart and go to checkout. You do not need an account.'],
  ['Which payment methods do you accept?', 'You can pay online with MTN Mobile Money (you approve a request on your phone with your PIN), or by card where offered. Pay-on-delivery is available only if the store has switched it on; it is shown at checkout when available.'],
  ['How long does delivery take?', 'Delivery time depends on your location and the delivery option you choose. The estimate for each option is shown at checkout.'],
  ['How can I track my order?', 'Open the Track order page and enter your order number with the phone number or email you used.'],
  ['What if my parcel is damaged or wrong?', 'Contact us as soon as you notice, with your order number and a photo. See the Delivery & returns page for details.'],
  ['Can I cancel my order?', 'Please contact us as early as possible. See the Delivery & returns page for the cancellation rules.']
];

const BLOG = [
  ['how-to-choose-a-perfume', 'How to choose a perfume',
    'A simple way to find a fragrance you will actually enjoy wearing.',
    `Choosing a perfume is personal, but a few steps make it easier.\n\nStart with the families. Fresh and citrus scents feel light and are popular in hot weather. Floral scents lean soft and romantic. Woody and oriental (sometimes called amber) scents feel warmer and deeper. Think about which scents you already like in soap, candles or food, and you will often find your family.\n\nThink about when you will wear it. A light scent suits the office and daytime. A richer scent often suits evenings and special occasions.\n\nTest before you commit. If you can, try a sample or a small size first. Spray on your skin rather than a paper strip, and wait at least 20 to 30 minutes: perfume changes as the top notes fade and the heart and base notes appear. Do not test more than two or three scents at a time, because your nose tires quickly.\n\nLast, remember that the same perfume can smell a little different on different people. That is normal, and it is why a small size is a sensible way to start.`],
  ['eau-de-parfum-vs-eau-de-toilette', 'Eau de Parfum vs Eau de Toilette',
    'What the names on the bottle mean and how they usually differ.',
    `Both words describe how much fragrance oil is mixed with alcohol.\n\nEau de Parfum (EDP) usually contains a higher share of fragrance oil, commonly quoted at around 15 to 20 percent. Eau de Toilette (EDT) usually contains less, commonly quoted at around 5 to 15 percent. There is no strict legal standard, so the exact amount varies from one fragrance house to another.\n\nWhat this means for you: an EDP often feels richer and may stay on the skin longer, while an EDT often feels lighter and fresher and is popular for daytime and warm weather. EDPs usually cost more per millilitre, but because they can be stronger you may need fewer sprays.\n\nThe best choice depends on the specific fragrance and on your skin, so check the concentration listed on each product and choose what suits how and when you will wear it.`],
  ['how-to-make-perfume-last-longer', 'How to make perfume last longer',
    'Practical habits that help fragrance stay with you through the day.',
    `Several simple habits can help.\n\nApply after a shower to clean, moisturised skin. Fragrance clings better to skin that is not dry, so an unscented lotion first can help.\n\nSpray on pulse points such as the wrists, neck and inner elbows, where skin is warmer. Do not rub your wrists together, because friction can break down the top notes faster.\n\nLayer where you can. A body lotion or shower gel from the same fragrance family gives the scent a base to hold on to.\n\nSpray from about 15 to 20 centimetres away so the mist spreads evenly.\n\nRemember that longevity differs between fragrances, skin types and weather. Heat and sweat can make a scent seem to fade or project faster, and our noses also get used to a scent we wear all day, so it may be noticeable to others even when you stop smelling it.`],
  ['choosing-a-perfume-as-a-gift', 'Choosing a perfume as a gift',
    'How to pick a fragrance gift with confidence.',
    `Perfume is a thoughtful gift, but it is also personal, so a little research helps.\n\nNotice what the person already wears. If you know their current fragrance, choose something in the same family, or a newer fragrance from the same brand.\n\nWhen unsure, go lighter and fresher. Very sweet, heavy or spicy scents divide opinion more than fresh, clean or softly floral ones.\n\nConsider a smaller size or a gift set so the person can try it without a big commitment.\n\nCheck the delivery date if the gift is for a birthday or event, and ask us on WhatsApp if you need help choosing.`],
  ['understanding-fragrance-notes', 'Understanding fragrance notes',
    'Top, middle and base notes explained in plain English.',
    `Perfumers describe a fragrance as a pyramid of notes that appear over time.\n\nTop notes are what you smell first. They are usually light, such as citrus or fresh herbs, and fade within the first several minutes.\n\nMiddle notes (also called heart notes) appear as the top notes fade. They form the main character of the fragrance, for example flowers or spices.\n\nBase notes arrive last and linger longest. Woods, musks, vanilla and amber are common base notes.\n\nWhen you read a product page, the notes tell you what to expect, but the way they blend matters more than any single note. That is why trying a fragrance on your skin is always worth it.`],
  ['how-to-store-perfume-correctly', 'How to store perfume correctly',
    'Keep your fragrances smelling the way they should.',
    `Heat, light and air are the enemies of perfume.\n\nKeep bottles in a cool, dry place away from direct sunlight. The bathroom is not ideal because heat and humidity change often.\n\nKeep the cap on when you are not spraying, and if the bottle came in a box, the box gives extra protection from light.\n\nAvoid leaving perfume in a hot car, which can change the scent.\n\nStored well, a fragrance can keep its character for years. If a perfume starts to smell sharply different or looks noticeably darker or cloudy, it may have turned.`]
];

function seedDefaults(db) {
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(SETTINGS)) insSetting.run(k, v);

  const insCat = db.prepare('INSERT OR IGNORE INTO categories (name, slug, sort) VALUES (?, ?, ?)');
  for (const c of CATEGORIES) insCat.run(...c);

  const insZone = db.prepare('INSERT OR IGNORE INTO delivery_zones (name, description, sort) VALUES (?, ?, ?)');
  ZONES.forEach((z, i) => insZone.run(z[0], z[1], i));

  const insPage = db.prepare('INSERT OR IGNORE INTO pages (slug, title, body, meta_title, meta_description) VALUES (?, ?, ?, ?, ?)');
  for (const p of PAGES) insPage.run(...p);

  if (db.prepare('SELECT COUNT(*) c FROM faqs').get().c === 0) {
    const insFaq = db.prepare('INSERT INTO faqs (question, answer, sort) VALUES (?, ?, ?)');
    FAQS.forEach((f, i) => insFaq.run(f[0], f[1], i));
  }
  const insPost = db.prepare('INSERT OR IGNORE INTO blog_posts (slug, title, excerpt, body, meta_description) VALUES (?, ?, ?, ?, ?)');
  for (const b of BLOG) insPost.run(b[0], b[1], b[2], b[3], b[2]);
}

module.exports = { seedDefaults, SETTINGS, EXPENSE_CATEGORIES };
