# ScentAura – Perfume store for Ghana

A complete online perfume shop you can run yourself: storefront, cart and checkout, Paystack payments (Mobile Money / card / bank transfer), delivery zones, order tracking, stock control, suppliers and purchasing, expenses and profit reports, discount codes, reviews, blog, and a staff dashboard with roles.

Prices are in Ghana cedis (GHS). "ScentAura" is a temporary name – change the name, logo and contact details in **Admin → Settings**; nothing is hard-coded.

## Quick start on your own computer (about 10 minutes)

1. Install **Node.js 22 (LTS)** from https://nodejs.org (accept the defaults).
2. Open a terminal in this folder and run:
   ```
   npm install
   copy .env.example .env        (Windows)     cp .env.example .env      (Mac/Linux)
   npm run create-admin          (asks for your name, email and a password)
   npm run seed:demo             (OPTIONAL – adds 5 clearly-labelled DEMO products to try the shop)
   npm run dev
   ```
3. Open http://localhost:3000 for the shop and http://localhost:3000/admin for the dashboard.

To test payments without real money, put your Paystack **test** secret key in `.env` – see `docs/01-BEGINNER-GUIDE.md`.

## What is in the box

| Folder / file | What it is |
|---|---|
| `src/` | The application (server code, payments, stock rules, reports) |
| `views/`, `public/` | The pages customers and staff see |
| `tests/` | 45 automated tests of the money, stock, payment and permission rules (`npm test`) |
| `docs/01-BEGINNER-GUIDE.md` | Step-by-step setup, daily use, going live, backups, troubleshooting |
| `docs/02-LAUNCH-CHECKLIST.md` | The business side: suppliers, authenticity, pricing, delivery, marketing |
| `docs/03-STARTUP-BUDGET-TEMPLATE.csv` | Editable budget (open in Excel / Google Sheets) |
| `docs/04-TECHNICAL-NOTES.md` | Why it is built this way, security, database, what is NOT included |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile` | One-command deployment with automatic HTTPS |

## Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | Run locally (restarts when files change) |
| `npm start` | Run for real (production) |
| `npm run create-admin` | Create an owner account |
| `npm run seed:demo` / `npm run clear:demo` | Add / remove the demo products |
| `npm run backup` | Safe copy of the database into `backups/` |
| `npm test` | Run the automated tests |

## Please read before launching

* The policy pages (delivery & returns, privacy, terms, authenticity) are **drafts with placeholders**. Edit them in Admin → Pages & policies and tick "approved". Get the privacy policy and terms checked by a lawyer.
* Do not claim "100% original" unless your supplier documents prove it.
* Delivery fees start **empty** (nothing is guessed). Set your own in Admin → Deliveries.
* The software has been tested here with automated tests and a simulated Paystack. **You must do a test-mode order with your own Paystack test keys** before taking real money (guide section 10).
