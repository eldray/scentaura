# MTN Mobile Money (MoMo) – setup

The shop already contains the full Mobile Money payment code. It stays **switched off until you paste in your MTN keys**. Nothing else needs changing.

## How it works for your customer
1. At checkout they choose **Pay with MTN Mobile Money** and enter the MoMo number to pay from.
2. The shop asks MTN to send a payment request to that phone.
3. The customer approves it with their MoMo PIN (if no prompt appears: dial `*170#` → *My Approvals*).
4. The order page updates by itself ("Payment received"). You never see the PIN.

Safety rules built in: an order is marked **paid only after the shop asks MTN directly** and MTN says *SUCCESSFUL* with the **same amount and currency** as the order. MTN's callback message is never trusted on its own – it just tells the shop to re-check. Repeated messages are harmless.

## What you need from MTN
Three values, put in your `.env` file:

| `.env` name | What it is |
|---|---|
| `MOMO_SUBSCRIPTION_KEY` | Your **Collections** subscription key (also called "Primary key") |
| `MOMO_API_USER` | The API user id (a long code like `3f2a1c…`) |
| `MOMO_API_KEY` | The API key that belongs to that user |
| `MOMO_ENV` | `sandbox` for testing, `mtnghana` for LIVE |

## Step A – Test first (sandbox, free, fake money)
1. Create an account at **momodeveloper.mtn.com** and subscribe to the **Collections** product. Copy the Primary key.
2. In `.env` set `MOMO_ENV=sandbox` and `MOMO_SUBSCRIPTION_KEY=<your key>`.
3. Run `npm run momo:setup-sandbox`. It prints `MOMO_API_USER=…` and `MOMO_API_KEY=…` – paste both into `.env`.
4. Run `npm run momo:check` – it should say **OK – MTN accepted your keys.**
5. Restart the shop (`npm start`). Admin → Settings should say "MTN Mobile Money is connected in SANDBOX mode".
6. Place an order and choose Mobile Money. In MTN's sandbox, any number is approved automatically (MTN publishes special test numbers that show *pending* or *failed* – see their sandbox docs). The sandbox only accepts the **EUR** currency, so the shop sends EUR in sandbox mode; the amount number is the same as in cedis.

## Step B – Go live
1. Apply for production Collections access with MTN Ghana (MTN's developer portal explains the business/KYC steps; MTN decides this, not the shop).
2. When MTN gives you the production **subscription key, API user and API key**, change `.env`:
   - `MOMO_ENV=mtnghana`
   - the three keys replaced with the live ones
   - `BASE_URL=https://your-real-domain.com` (must be https – MTN's callback needs it)
3. If MTN gives you a different production address than the default `https://proxy.momoapi.mtn.com`, put it in `MOMO_BASE_URL`.
4. Run `npm run momo:check`, restart, then place **one small real order** yourself and confirm it shows paid.

## Good to know
* **MTN numbers only.** This direct integration collects from **MTN MoMo wallets**. Vodafone Cash and AirtelTigo Money customers cannot pay through it. Options: keep **Pay on delivery** switched on (Admin → Settings), or later add an aggregator that supports all networks (Paystack, Hubtel, etc.). Paystack code is still included – set `PAYSTACK_SECRET_KEY` and it appears as a second option.
* **Refunds are manual.** You send the money back yourself (MoMo transfer) and press *Record refund → I paid the customer myself* on the order.
* **A payment not confirmed?** Open the order in Admin → **Check payment with MTN**.
* **Fees:** MTN's charges are not auto-recorded (shown as 0). Ask MTN for your rate when you sign.
* **Real MTN servers were not reachable from the build environment.** The request shapes follow MTN's published Collection API (token → `requesttopay` → status check) and are covered by tests against a simulated MTN. Do the sandbox test (Step A) and one small live order (Step B) before launch. If MTN rejects a request, the reason is stored on the payment and shown in the server log.
