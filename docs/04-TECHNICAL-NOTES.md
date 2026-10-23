# Technical notes

## 1. Why a custom app instead of WooCommerce / Shopify / Wix?

You asked for a custom build but also for a recommendation if a ready-made platform is simpler. Honest comparison (prices change – check each provider's current pricing yourself):

| | Custom app (this project) | WooCommerce (WordPress) | Shopify / Wix-style hosted |
|---|---|---|---|
| Monthly cost | Only your hosting + domain | Hosting + domain (+ paid plugins you may need) | Subscription, usually plus a transaction fee unless you use their own payments |
| Ghana Mobile Money | Paystack built in | Paystack plugin exists | Depends on the platform's supported gateways in Ghana – check before choosing |
| Ease for a beginner | Dashboard is simple, but **you** (or a helper) must host, back up and update it | Familiar admin, but constant plugin/security updates | Easiest to start; least maintenance |
| Control / customisation | Full | High | Limited to what the platform allows |
| Risk | You own maintenance and security | Plugin conflicts, hacked sites if not updated | Platform lock-in and fees |

**Recommendation:** if you have no technical helper at all and want to be selling within days, a hosted platform with a Ghana-supported payment gateway is the least maintenance. This project exists for when you want full control, no platform subscription, custom Ghana delivery zones and profit tracking in one place. Both are legitimate; the guide assumes you are running this one.

## 2. Architecture (one coherent stack)

* **Node.js 22 + Express 5**, server-rendered pages (EJS). No separate frontend build, no extra services. The storefront works without JavaScript.
* **SQLite** (single file, WAL mode, foreign keys on) via Node's built-in `node:sqlite` (no native compile step; needs Node 22.13+ or 24), all money as **integer pesewas**.
* **MTN MoMo Collection API** (`src/services/momo.js`): OAuth token (cached ~1h), `POST /collection/v1_0/requesttopay` with a UUID `X-Reference-Id`, status via `GET …/requesttopay/{id}`; unsigned callback only triggers a re-check. MTN-only; refunds manual. Config `MOMO_*`; `npm run momo:check`.
* **Paystack** (optional) over its REST API (initialise, verify, refund) plus signed webhooks.
* **sharp** for safe image processing, **bcryptjs** for passwords, **helmet** for security headers, **express-rate-limit**, **nodemailer** for email.

**Deviation from the prompt's suggested stack (React + TypeScript + PostgreSQL + Prisma):** I chose server-rendered pages and SQLite deliberately. For a single small shop it means one process, no database server to buy or secure, one file to back up, fast pages on cheap hosting, and far less for a beginner to break. The trade-offs: SQLite means **one server only** (you cannot run several copies behind a load balancer) and a persistent disk is required. If the business outgrows that, the data layer is isolated in `src/services/*` and `src/db.js`; moving to PostgreSQL is a contained piece of work, not a rewrite, but it is work.

## 3. Money and stock rules (all enforced on the server)

* Browsers send only variant ids, quantities, a delivery option id and a code. Prices, discounts, delivery and totals are recalculated in `services/pricing.js`.
* Order creation is **one database transaction**: validate → create order → snapshot items (name, size, SKU, price, cost) → reserve stock → count coupon use.
* Stock has `on_hand`, `reserved`, `available = on_hand − reserved`. A database constraint (`reserved <= on_hand`, no negatives) plus a conditional `UPDATE` makes overselling impossible even under concurrency. Every change writes an append-only `stock_movements` row (type, quantity, balance after, reference, reason, user).
* Online orders reserve stock when placed and **deduct when payment is confirmed**; unpaid ones release stock after the "hold" time (default 120 min). Pay-on-delivery orders reserve at order and deduct at dispatch; the order stays **unpaid until staff press "Record cash collected"**.
* Cancel before payment → release; cancel after payment → stock restored and the order is flagged "refund the customer"; returns restock only if staff tick "resaleable".
* Costs use **weighted-average cost**, recalculated on each goods-received.

## 4. Payment flow

1. Customer confirms → order saved (status *Payment pending*) → server calls Paystack `transaction/initialize` with the server-calculated amount → customer is redirected to Paystack.
2. Paystack redirects back to `/payment/callback`. The shop **asks Paystack** (`transaction/verify`) – the return page alone never marks anything paid.
3. The signed webhook `charge.success` (HMAC-SHA512 of the raw body with your secret key, header `x-paystack-signature`) also confirms. Both paths use the same function, which checks **reference, amount and currency** against our records and acts **once** (duplicate events are stored with a unique key and ignored).
4. Failed/abandoned → "Pay now" retry creates a new reference (`ORDER-1`, `ORDER-2`…); only one attempt can succeed.
5. Payment arriving after a reservation expired re-takes stock if available; if not, the order is flagged for the owner to refund or contact the customer.
6. Refunds go through Paystack's refund API (status updated by the `refund.*` webhook) or are recorded as **manual** (e.g. you sent Mobile Money yourself, or pay-on-delivery orders). Paystack's refund page does not describe Mobile Money refund behaviour in Ghana; confirm it with Paystack, and use "manual" if needed.

Paystack documents webhook source IPs; this app verifies the **signature** (the recommended check) and does not additionally IP-filter.

## 5. Security measures implemented

Password hashing (bcrypt, cost 12), server-side validation everywhere, per-session CSRF tokens on every form, rate limits (login, reset, tracking, checkout, coupons, global), secure/HttpOnly/SameSite cookies, new session id on login, 2-hour idle sign-out for staff, backend role checks on every admin route, no default credentials (owner created via CLI or a one-time token page that only works while no users exist), Content-Security-Policy and other helmet headers, escaped output in all templates, CSV formula-injection guard, image uploads validated by content, re-encoded to WebP and renamed (no original files kept), reset tokens stored only as hashes and expiring in 1 hour, audit log of sensitive actions, secrets only via environment variables, production start-up refuses weak configuration, `X-Robots-Tag: noindex` and `no-store` on `/admin`.

**Not included / you must handle:** server hardening (firewall, OS updates), DDoS protection, off-site backup automation, two-factor authentication, penetration testing, and legal review of policies.

## 6. What is implemented vs. the original brief

Implemented and automatically tested: catalogue with variants and filters/sorting, cart, guest checkout, Ghana phone validation, server-side totals, coupons (percent/fixed/min spend/expiry/caps/first-order/once-per-customer), referral codes, delivery zones/methods/fees/free-over/minimums, order statuses and tracking page, Paystack payments + webhooks + retries + refunds, pay-on-delivery, inventory ledger, stock counts, suppliers/purchase orders/receiving/supplier payments, expenses, gross/net profit estimates, margin vs markup, reconciliation report, CSV exports, roles, audit log, reviews with moderation, wishlist, blog, FAQ, editable policies with approval flags, SEO basics (titles, meta, canonical, sitemap, robots, JSON-LD product/FAQ/article, Open Graph), WhatsApp click-to-chat and share links, email notifications (when SMTP is set).

**Not implemented (be aware):**
* **SMS / WhatsApp automatic notifications** – only click-to-chat links. Needs an approved provider account.
* **Abandoned-cart reminders** – not built (needs stored consent plus an email/SMS integration).
* **Courier APIs** – manual courier and tracking-number management only (works from day one).
* **Product barcodes** are stored but there is no scanner workflow.
* **Multi-currency / other countries** – GHS only; structure allows later work.
* **Automated database restore tooling** – documented manual procedure.
* **Real MTN MoMo and Paystack calls were not exercised in development** (no keys / the build environment cannot reach Paystack). Request shapes follow Paystack's documentation and are covered by tests against a simulated Paystack. **Do a full test-mode order before going live.**
* Email sending was verified only as far as queuing/logging; test with your real SMTP account.

## 7. Tests (`npm test` – 47 tests)

Pricing and phone validation; coupon rules; stock reservation, no-oversell, no-negative stock, rollback on failure, expiry/release, manual-adjust rules, weighted-average cost; COD flow; Paystack signature, duplicate webhook, amount/currency mismatch, retry, late payment, refunds (partial/full/failed), cancellation/return stock handling; profit report arithmetic; HTTP-level: all public pages, a complete guest checkout → webhook → paid journey, CSRF, customer registration/login, admin login, **role permissions for GET and POST**, image upload (valid and malicious), admin order handling, security headers.

Mobile responsiveness was checked in a headless browser at phone (390px) and desktop (1280px) widths across every storefront and admin page (no horizontal overflow, no console or CSP errors), and a full buyer-to-delivered admin journey plus product-photo upload was driven end to end in the browser. Run your own checks on real devices.

**Images from the web:** product photos can be fetched from `https://` addresses. The downloader refuses non-https, non-443 ports, credentials in the address and any host that resolves to a private/internal address (checked at connection time, including after redirects), limits size to 5 MB and time to 10 s, and re-encodes the result with sharp. The sample home-page photos are hot-linked from Unsplash (free licence) and fall back to local artwork if they cannot load; replace them with your own in Settings.

**Database driver:** Node's built-in `node:sqlite` (Node 22.13+). It is marked experimental by Node; the app wraps it in `src/db.js`, which is the only file that touches the driver.

## 8. Database

`src/schema.sql` (applied automatically and idempotently on start). Main tables: users, customers, addresses, brands, categories, products, product_variants, product_images, suppliers, purchase_orders, purchase_items, supplier_payments, stock_movements, delivery_zones, delivery_rates, couriers, coupons, coupon_redemptions, orders, order_items (snapshot), order_events, payments, payment_events (unique key = idempotency), refunds, reviews, wishlists, expenses, notifications, audit_logs, settings, pages, faqs, blog_posts, sessions. Foreign keys are enforced; deletions: products/variants with history cannot be deleted (archive/deactivate instead), orders keep snapshots even if products change.
