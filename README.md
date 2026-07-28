# MarzPay payments for katoemmanganda.com

Mobile money (MTN + Airtel) and card payments, built as:

- **`server/`** — a small Node/Express backend. This is the *only* thing
  that holds your MarzPay API key/secret and the only thing that talks to
  `wallet.wearemarz.com`.
- **`public/`** — a plain HTML/CSS/JS widget you embed into your existing
  site. It never sees your credentials — it only calls your own backend.

**Do not skip the backend and call MarzPay from browser JavaScript.**
MarzPay auth is a Basic Auth header built from your key + secret — if that
header exists in client-side code, anyone can copy it from the browser's
network tab and make payments (or worse) as your business.

## 0. First: rotate your credentials

The key/secret you shared earlier are compromised (they were visible in a
screenshot). Before doing anything else, go to your MarzPay dashboard and
**regenerate both**. Use the new ones below — never reuse the old pair.

## 1. Backend setup

```bash
cd server
cp .env.example .env
# edit .env: paste your NEW MarzPay key/secret, set ALLOWED_ORIGINS to
# your real domain(s), set CALLBACK_URL to a route on your own server.
npm install
npm start
```

Deploy this somewhere with HTTPS (a subdomain like `api.katoemmanganda.com`
behind your host's TLS, or a platform like Render/Railway/Fly/a VPS with
Let's Encrypt). Never run it over plain HTTP in production — mobile money
approval and card redirects both involve payment data in transit.

### Replace the example price catalog

Open `server/server.js` and look for `PRICE_CATALOG`. Right now it has one
placeholder product. Replace it with real lookups against your actual
products/orders (database, CMS, whatever you already use). This is what
stops someone from tampering with the price in their browser before
paying — **the server decides the amount, never the client.**

If you need free-form amounts (e.g. donations, custom invoices), the
`amount` fallback path is already there and clamped to MarzPay's own
500–10,000,000 UGX limits, but prefer `product_id` wherever the amount is
tied to something you sell.

## 2. Frontend: embed the widget

Add these to any page on katoemmanganda.com (the checkout page, a product
page, wherever "Pay now" should appear):

```html
<link rel="stylesheet" href="/path/to/payment-widget.css">
<script src="/path/to/payment-widget.js"></script>

<div id="buy-button"></div>
<script>
  MarzPayWidget.mount('#buy-button', {
    backendUrl: 'https://api.katoemmanganda.com', // your server, not MarzPay
    productId: 'example-product-1',
    description: 'Order #1024',
    buttonLabel: 'Pay now',
    onSuccess: (result) => { /* e.g. redirect to a thank-you page */ },
    onFailure: (result) => { /* show a retry message */ },
  });
</script>
```

Open `public/demo.html` in a browser (with the backend running) to see it
end to end. The widget:

- Shows Mobile Money / Card tabs
- For mobile money: takes the phone number, shows a "check your phone"
  screen, and polls your backend for the outcome
- For card: redirects to MarzPay's hosted card gateway, then back to your
  `CARD_RETURN_URL`
- Is namespaced (`.mzp-*` classes) so it won't clash with your site's CSS,
  and works on mobile

## 3. Confirm payment status the right way

Two ways your backend learns a payment finished:

1. **Webhook** (`POST /api/payments/webhook`) — MarzPay calls this
   automatically when a collection completes or fails. This is the
   authoritative source — **fulfil orders here**, in the `TODO` marked in
   `server.js`, not from anything the browser tells you.
2. **Status polling** (`GET /api/payments/status/:reference`) — used by the
   widget just to update the UI while the customer waits. Treat it as
   informational only.

Never mark an order as paid just because the browser called `onSuccess` —
that callback is for updating your UI (e.g. "thanks, redirecting you"),
not for releasing goods or services. Always gate fulfilment on the webhook.

## 4. Security checklist

- [x] API key/secret only ever live in `server/.env`, read via
      `process.env`, never sent to the browser
- [x] CORS locked to `ALLOWED_ORIGINS` (your real domain only)
- [x] Rate limiting on the payment-creation endpoint
- [x] Server-side amount validation/catalog — the browser can't set its own price
- [x] Phone numbers validated and normalized server-side before calling MarzPay
- [x] `helmet()` for standard security headers
- [ ] **You add:** HTTPS in front of the backend (required, not optional)
- [ ] **You add:** a real database instead of the in-memory `Map` in
      `server.js` (it resets on every restart — fine for testing, not for
      production)
- [ ] **You add:** `.env` to `.gitignore` before pushing this to any repo
- [ ] **You add:** monitoring/alerting on webhook failures so a payment
      never silently fails to fulfil an order

## 5. Files in this project

```
server/
  server.js        — Express backend, the only thing that talks to MarzPay
  package.json
  .env.example      — copy to .env and fill in real values
public/
  payment-widget.js  — embeddable widget, no credentials, talks to your backend
  payment-widget.css — namespaced styles
  demo.html          — working example of embedding the widget
```
