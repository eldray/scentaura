# Beginner's guide to running ScentAura

Written for someone with little technical experience. Take it one section at a time. Words in `code style` are things you type or click exactly.

---
## 0. The big picture (2 minutes)

* The shop is one program. It stores everything (products, orders, customers) in **one database file** and the product photos in an **uploads folder**. Both live in a "data" place on your server. **If you lose that place without a backup, you lose the shop** – so section 14 (backups) matters.
* You manage the shop from the **dashboard** at `your-website/admin`. You never edit code to add products or change prices.
* Customers pay through **Paystack**. Paystack, not you, handles card numbers and Mobile Money PINs. Your shop never sees them.

---
## 1. What you need (accounts and software)

| Need | What for | Notes |
|---|---|---|
| A computer (Windows, Mac or Linux) | Trying the shop and managing it | Any recent laptop |
| **Node.js 22 (LTS)** – https://nodejs.org | Runs the shop on your computer | Free |
| A **Paystack** account – https://paystack.com | Taking Mobile Money / card payments | Free to open; business verification is required to go live. Check Paystack's site for current fees and settlement times. |
| A **domain name** (e.g. `scentaura.com`, or a `.com.gh`) | Your web address | Bought from any domain seller. Check current prices when you buy. |
| A **server** to run the shop | Hosting | See section 12. It must keep a **persistent disk** (the database is a file). |
| An **email sending account** (SMTP) | Order emails | Optional but strongly recommended. Many email providers offer SMTP details. |
| A business **phone with WhatsApp** | Customer chat button | Use a dedicated business number if you can |

---
## 2. Install on your computer

1. Install Node.js (accept all defaults). Restart your computer if asked.
2. Unzip the project. Open the folder, then open a terminal in it:
   * Windows: click the folder's address bar, type `cmd`, press Enter.
   * Mac: right-click the folder → "New Terminal at Folder".
3. Type `npm install` and press Enter. Wait until it finishes (a minute or two).

---
## 3. Settings file (environment variables)

1. Make a copy of the file `.env.example` and name the copy `.env` (Windows: `copy .env.example .env`).
2. Open `.env` in Notepad. The defaults already suit your own computer (`NODE_ENV=development`, `BASE_URL=http://localhost:3000`). Just set:
   * `SESSION_SECRET=` a long random text. Create one with: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` and paste the result.
3. **Never share or upload `.env`** – it holds secrets. It is already excluded from backups of the code and from Docker images.

---
## 4. Create the database

Nothing to do. The first time you start the shop it creates the database and fills in your starting settings, FAQ answers, six fragrance-guide articles and draft policy pages. (Command, if you want to do it by hand: `npm run migrate`.)

When you update the software later, run `npm run migrate` – it only adds what is missing and never deletes your data.

---
## 5. Create the first administrator (the Owner)

In the terminal: `npm run create-admin`. Type your name, email, and a password of at least 10 characters (the password is hidden while you type). This is the only way the first account is created – there is **no default password** in the code.

Add staff later in **Admin → Staff & permissions**.

| Role | Can do |
|---|---|
| Owner | Everything, including Settings and Staff |
| Store manager | Everything except Settings and Staff |
| Sales / order processing | Orders, customers, deliveries |
| Inventory staff | Products, stock, suppliers |

The permissions are enforced by the server, not just hidden buttons.

---
## 6. Run the shop on your computer

`npm run dev` → open http://localhost:3000 (the shop) and http://localhost:3000/admin (the dashboard). Press `Ctrl + C` in the terminal to stop it.

Want to see it with sample products first? `npm run seed:demo` adds five **DEMO** products, placeholder delivery options and a code `WELCOME10`. Remove them with `npm run clear:demo` before you add real stock. **Do not sell demo products.**

---
## 7. Add perfumes and photos

**Admin → Products → Add product.**

1. Fill in the name, brand, category, who it is for, concentration (Eau de Parfum etc.) and notes. **Only write facts you can verify.** Leave "Longevity", "Projection" and "Sourcing" empty if you are not sure – the shop simply will not show them.
2. Save. You land on the edit page.
3. **Sizes, prices & stock:** add each bottle size (30, 50, 100 ml…). Every size has its own price, optional discount price, cost (what you paid), low-stock alert level and starting stock. Prices are in cedis, like `450.00`.
4. **Photos:** upload several angles (JPEG, PNG or WebP up to 5 MB). The first is the main photo. Add a short description for each (helps blind visitors and Google).
5. Set Status to **Active**. Draft products are invisible to customers.

Tips: "Duplicate as draft" copies a product's details for similar items. "Archive" hides a product but keeps its history. Products that have orders cannot be deleted, only archived.

Changing stock later: **Admin → Inventory**. Every change needs a reason and is recorded with your name. To receive goods from a supplier use **Suppliers & purchases** so your cost is updated too.

---
## 8. Delivery charges

**Admin → Deliveries.** The shop starts with zone names (Accra & Tema, Kumasi, Tamale, other regional capitals, other towns, store pickup) but **no prices** – only you know your courier costs.

For each zone add one or more options: Standard, Express, Courier, Customer pickup, Collection point. Set the fee, an optional "free over" amount, a minimum order, and the estimated time text customers see. Add your riders/couriers under **Couriers**.

Customers must pick an option at checkout, so add at least one before launch.

---
## 9. Connect Paystack

1. Sign in at dashboard.paystack.com → **Settings → API Keys & Webhooks**.
2. Copy the **Test Secret Key** (starts `sk_test_`) into `.env` as `PAYSTACK_SECRET_KEY=` and the Public key as `PAYSTACK_PUBLIC_KEY=`.
3. In the same Paystack page, set the **Webhook URL** to `https://YOUR-DOMAIN/webhooks/paystack` (it must be reachable from the internet – on your own computer use a tunnel tool such as ngrok, or just rely on the "Check payment with Paystack" button on each order).
4. Under Paystack **Settings → Preferences/Payment channels**, make sure the methods you want (Mobile Money, Card, Bank transfer) are switched on. The shop offers whatever Paystack has enabled for your account.
5. Restart the shop. **Admin → Settings → System status** should say "Paystack is connected in TEST mode".

Paystack's own documentation says webhooks are signed with your secret key in the `x-paystack-signature` header. The shop checks this signature and also re-checks the amount, currency and reference before marking anything as paid.

---
## 10. Test a transaction (no real money)

1. Add a product (or the demo products) and open the shop.
2. Add to cart → Checkout → use a Ghana number such as `024 123 4567`, choose a delivery option, choose "Pay online with Paystack" → Review → Confirm.
3. On Paystack's page choose **card** and use one of Paystack's **test cards** (listed in Paystack's "Test payments" documentation) or the Mobile Money **test numbers** shown there. Test mode never moves real money.
4. You should return to your order page showing **Paid**. In **Admin → Orders** open the order: stock has been deducted, the payment shows in **Payments**, and an email appears in **Settings → Email outbox** (or in the customer's inbox if email is set up).
5. Also test: a **failed** payment (use Paystack's failing test card) → order shows "Pay now" to retry; cancelling an unpaid order frees its stock; a **refund** from the order page; pay-on-delivery (switch it on in Settings first).

Only switch to your **live** keys (`sk_live_`) after all of this works and Paystack has activated your account.

---
## 11. Edit business details, policies and content

* **Settings:** name, logo, banner image, phone, email, WhatsApp number (this switches on the WhatsApp buttons), address, hours, map, social links, analytics.
* **Pages & policies:** About, Contact, Delivery & returns, Authenticity, Privacy, Terms. Replace every `[OWNER: …]` placeholder, then tick **approved**. The Dashboard checklist reminds you until all are approved.
* **FAQ, Blog, Reviews:** edit questions, publish articles, approve or reject customer reviews. Only customers who received a product can review it.

---
## 12. Deploy (put the shop on the internet)

**Important:** this shop stores data in a file, so it needs a server with a **disk that is kept between restarts**. "Serverless" hosts such as Vercel or Netlify are **not suitable** – the shop would forget its orders. Use a small virtual server (a "VPS" from any provider) or a platform that offers a persistent volume. Compare current prices yourself when you choose.

### Option A – Docker on a VPS (recommended; includes automatic HTTPS)
1. Rent a small Linux server (Ubuntu). Note its IP address.
2. Point your domain to it: at your domain seller, create an **A record** for `@` and `www` with the server's IP.
3. On the server install Docker (follow Docker's official "Install on Ubuntu" page).
4. Upload the project folder to the server (e.g. with an SFTP program such as FileZilla), without `node_modules` or `.env`.
5. On the server, in the project folder: copy `.env.example` to `.env` and fill it in (set `DOMAIN`, `BASE_URL=https://your-domain.com`, a long `SESSION_SECRET`, the Paystack and SMTP details).
6. Run: `docker compose up -d --build`
7. Create the owner: `docker compose exec shop node src/scripts/create-admin.js`
8. Visit `https://your-domain.com`. The certificate is requested automatically (this takes a minute; ports 80 and 443 must be open).

### Option B – without Docker
Install Node 22 on the server, upload the project, `npm ci --omit=dev`, create `.env` (set `NODE_ENV=production` and `BASE_URL=https://…`), then run it with a process manager such as PM2 (`pm2 start src/server.js --name scentaura`, `pm2 save`, `pm2 startup`) behind a web server that provides HTTPS (e.g. Caddy or nginx + Let's Encrypt).

### HTTPS
In production the shop refuses to start unless `BASE_URL` starts with `https://` and `SESSION_SECRET` is long, and it marks cookies "secure". Caddy (included) obtains and renews the certificate for you.

### First-day checks after deploying
* `https://your-domain.com/healthz` shows `{"ok":true}`.
* Admin → Settings → System status shows Paystack and email as connected.
* Paystack webhook URL is `https://your-domain.com/webhooks/paystack`.
* Place one real small order yourself with live keys, then refund it.

---
## 13. Domain and email – where to buy

Any reputable domain seller (for example Namecheap, GoDaddy, or a Ghana-based registrar for `.com.gh`) works. Buy the domain in **your** name/business name and turn on auto-renew so you never lose it. For business email (`orders@your-domain.com`), many hosts and email providers offer SMTP; paste the details into `.env` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`). Check each provider's current pricing yourself.

---
## 14. Backups and restoring (do not skip)

**Back up two things:** the database **and** the photos folder.

* Database: `npm run backup` (Docker: `docker compose exec shop node src/scripts/backup.js`). It writes a safe copy even while the shop is running and keeps the newest 30.
* Photos: copy the `uploads` folder (Docker: it is inside the `shopdata` volume at `/data/uploads`).
* **Copy both somewhere that is NOT on the same server** (Google Drive, an external disk). Do this at least weekly, daily once you have real orders.

**Restore:** stop the shop → replace `data/scentaura.db` with the backup file (rename it to `scentaura.db`) and delete any `scentaura.db-wal` / `scentaura.db-shm` next to it → copy the photos back → start the shop. Practise a restore **once on your own computer** before you need it.

---
## 15. Updating the website safely

1. Take a backup first (section 14).
2. Upload the new project files over the old ones (keep your `.env` and data).
3. `npm ci --omit=dev` then `npm run migrate` then restart (Docker: `docker compose up -d --build`).
4. Check the shop and `/healthz`. If something is wrong, restore the backup and the old files.

---
## 16. Watching for problems

* `https://your-domain.com/healthz` – you can have a free uptime-monitoring service ping this and message you if it fails.
* Logs: `docker compose logs -f shop` (or `pm2 logs`).
* In the dashboard: **Orders needing attention** (red box on the Dashboard) lists payment/stock problems, **Payments** shows reconciliation problems, **Settings → Activity log** shows who did what, **Settings → Email outbox** shows emails that failed.

---
## Daily routine (10 minutes)

1. Dashboard → read any red "needs attention" items.
2. Orders → "Awaiting dispatch": print the packing slip, pack, set **Packed / Dispatched**, choose the courier and enter the tracking number.
3. When it arrives set **Delivered** (for pay-on-delivery press **Record cash collected**).
4. Check low stock → create a purchase order; when goods arrive press **Receive**.
5. Record expenses; review **Reports** weekly.

## How the money numbers work
* **Sales** = what paid customers were charged (not profit).
* **Gross profit** = selling price − what the bottle cost you.
* **Margin** = gross profit ÷ selling price; **markup** = gross profit ÷ cost. They are different.
* **Net operating profit (estimate)** = gross profit + delivery fees collected − refunds − Paystack fees − expenses you recorded. It is only as good as the costs/expenses you enter, and the report warns you if some sold items have no cost.
* **Cash** is shown separately: buying stock reduces cash but is not an expense until sold.
* Stock cost uses **weighted-average cost**: when you receive new stock at a new price, the average is recalculated.

---
## Troubleshooting (plain English)

| Problem | What to do |
|---|---|
| "npm is not recognised" | Node.js is not installed or the terminal was open before installing. Install Node, close and reopen the terminal. |
| Port already in use | Another program uses port 3000. Change `PORT=` in `.env` (and `BASE_URL`). |
| I cannot sign in to the dashboard | Run `npm run create-admin` again – it adds another owner. Or use "Forgot password" (needs email set up). Too many wrong tries locks you out for a while; wait 15 minutes. |
| Customer says they paid but the order shows unpaid | Open the order → **Check payment with Paystack**. If Paystack says success, it is marked paid. Check your webhook URL in Paystack. |
| Order says "Paid after the item sold out" | Someone paid after their reservation expired and the stock was sold. Contact them or refund from the order page. |
| No emails arrive | Email is not set up (see the Email outbox). Fill in the SMTP lines in `.env` and restart. Check spam folders. |
| Photos do not show after a restart | The uploads folder was not on a persistent disk. Restore from backup and mount a volume. |
| "Cannot start in production" | `.env` needs a long `SESSION_SECRET` and a `BASE_URL` starting `https://`. |
| Payment page does not open | Wrong or missing `PAYSTACK_SECRET_KEY`, or Paystack account not activated for live mode. The order is saved; the customer can press **Pay now** later. |
| Checkout says delivery has not been set up | Add a delivery option in Admin → Deliveries. |
| Shop is slow or down | `docker compose logs shop`, restart with `docker compose restart shop`, and check the server's disk is not full. |

If you are stuck, copy the exact error text from the logs when you ask a developer for help – never send them your `.env`.
