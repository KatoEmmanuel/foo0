/**
 * katoemmanganda.com — MarzPay collections backend
 *
 * WHY THIS EXISTS:
 * MarzPay authenticates requests with a Basic Auth header built from your
 * API key + secret. If that header is ever built in browser JavaScript,
 * anyone visiting your site can read it from dev tools / network tab and
 * make payment requests as you. So this small server is the ONLY place
 * that ever sees your credentials or talks to MarzPay directly. Your
 * website's frontend talks to THIS server, never to MarzPay.
 *
 * SETUP:
 *   1. cp .env.example .env   and fill in your (rotated) MarzPay credentials
 *   2. npm install
 *   3. npm start
 *   4. Put this server behind HTTPS (e.g. via your host, Nginx, or a
 *      platform like Render/Railway/Fly that terminates TLS for you).
 *      Never run this over plain HTTP in production.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4, validate: isUuid } = require('uuid');
const fetch = require('node-fetch');

// ---------------------------------------------------------------------------
// Startup validation — fail loudly instead of silently running insecurely
// ---------------------------------------------------------------------------
const REQUIRED_ENV = ['MARZPAY_API_KEY', 'MARZPAY_API_SECRET', 'MARZPAY_BASE_URL', 'ALLOWED_ORIGINS'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}. Check your .env file.`);
    process.exit(1);
  }
}

const {
  MARZPAY_API_KEY,
  MARZPAY_API_SECRET,
  MARZPAY_BASE_URL,
  PORT = 4000,
  ALLOWED_ORIGINS,
  CALLBACK_URL,
  NODE_ENV = 'production',
} = process.env;

const AUTH_HEADER = 'Basic ' + Buffer.from(`${MARZPAY_API_KEY}:${MARZPAY_API_SECRET}`).toString('base64');
const allowedOrigins = ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// Product / price catalog — SERVER decides the amount, never the browser.
// Replace this with a real lookup against your database or CMS. This
// stops a customer from opening dev tools and changing the price they pay.
// ---------------------------------------------------------------------------
const PRICE_CATALOG = {
  // 'product-id': { amount: <UGX integer>, description: 'Human readable' }
  'example-product-1': { amount: 25000, description: 'Sample product — replace with your catalog' },
};

function resolveAmountAndDescription({ product_id, amount, description }) {
  if (product_id) {
    const item = PRICE_CATALOG[product_id];
    if (!item) return { error: 'Unknown product_id' };
    return { amount: item.amount, description: item.description };
  }
  // Fallback path for free-form/custom amounts (donations, custom invoices, etc).
  // Still clamp to MarzPay's own limits and reject anything malformed.
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount < 500 || numericAmount > 10000000) {
    return { error: 'amount must be a number between 500 and 10,000,000 UGX' };
  }
  return {
    amount: Math.round(numericAmount),
    description: (description || 'Payment').toString().slice(0, 255),
  };
}

// ---------------------------------------------------------------------------
// In-memory transaction store — swap for a real database in production.
// Keyed by our reference (UUID) so we can look up status/webhooks later.
// ---------------------------------------------------------------------------
const transactions = new Map();

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '20kb' }));

app.use(
  cors({
    origin(origin, callback) {
      // Allow same-origin/non-browser tools (no origin header) and your allowlist only.
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin not allowed'));
    },
    methods: ['GET', 'POST'],
  })
);

// Tight rate limit on payment creation to block abuse / reference-spam.
const collectLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many payment attempts. Please try again later.' },
});

const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use(generalLimiter);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
const UG_MOBILE_RE = /^\+256(7\d{8}|3[19]\d{7})$/;

function normalizeUgandaPhone(raw) {
  if (!raw) return null;
  let p = String(raw).trim().replace(/[\s-]/g, '');
  if (p.startsWith('0')) p = '+256' + p.slice(1);
  if (p.startsWith('256')) p = '+' + p;
  if (!p.startsWith('+256')) return null;
  return UG_MOBILE_RE.test(p) ? p : null;
}

// ---------------------------------------------------------------------------
// POST /api/payments/collect
// Body: { method: 'mobile_money' | 'card', phone_number?, product_id?, amount?, description?, customer_name? }
// ---------------------------------------------------------------------------
app.post('/api/payments/collect', collectLimiter, async (req, res) => {
  try {
    const { method = 'mobile_money', phone_number, product_id, amount, description, customer_name } = req.body || {};

    if (!['mobile_money', 'card'].includes(method)) {
      return res.status(400).json({ status: 'error', message: 'Invalid payment method' });
    }

    const priced = resolveAmountAndDescription({ product_id, amount, description });
    if (priced.error) {
      return res.status(400).json({ status: 'error', message: priced.error });
    }

    let normalizedPhone = null;
    if (method === 'mobile_money') {
      normalizedPhone = normalizeUgandaPhone(phone_number);
      if (!normalizedPhone) {
        return res.status(400).json({
          status: 'error',
          message: 'Enter a valid Ugandan mobile money number, e.g. 0781234567',
        });
      }
    }

    const reference = uuidv4();

    const form = new URLSearchParams();
    form.append('amount', String(priced.amount));
    form.append('country', 'UG');
    form.append('reference', reference);
    form.append('description', priced.description);
    if (CALLBACK_URL) form.append('callback_url', CALLBACK_URL);
    if (method === 'card') {
      form.append('method', 'card');
    } else {
      form.append('phone_number', normalizedPhone);
    }

    const marzRes = await fetch(`${MARZPAY_BASE_URL}/collect-money`, {
      method: 'POST',
      headers: {
        Authorization: AUTH_HEADER,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });

    const marzData = await marzRes.json();

    if (!marzRes.ok || marzData.status !== 'success') {
      return res.status(502).json({
        status: 'error',
        message: marzData.message || 'Payment provider declined the request',
      });
    }

    transactions.set(reference, {
      reference,
      uuid: marzData.data?.transaction?.uuid,
      method,
      amount: priced.amount,
      description: priced.description,
      customer_name: customer_name ? String(customer_name).slice(0, 120) : null,
      status: marzData.data?.transaction?.status || 'processing',
      created_at: new Date().toISOString(),
    });

    // Only forward what the frontend actually needs — never leak raw provider payloads.
    const responsePayload = {
      status: 'success',
      reference,
      transaction_uuid: marzData.data?.transaction?.uuid,
      transaction_status: marzData.data?.transaction?.status,
    };
    if (method === 'card') {
      responsePayload.redirect_url = marzData.data?.redirect_url;
    }

    return res.json(responsePayload);
  } catch (err) {
    console.error('collect error:', err.message);
    return res.status(500).json({ status: 'error', message: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/payments/status/:reference
// Frontend polls this (mobile money has no redirect, so the widget needs
// a way to find out when the customer has approved/declined the USSD prompt).
// ---------------------------------------------------------------------------
app.get('/api/payments/status/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    if (!isUuid(reference)) {
      return res.status(400).json({ status: 'error', message: 'Invalid reference' });
    }
    const local = transactions.get(reference);
    if (!local) {
      return res.status(404).json({ status: 'error', message: 'Unknown transaction' });
    }

    // Re-check with MarzPay in case the webhook hasn't landed yet.
    if (local.uuid && !['completed', 'failed'].includes(local.status)) {
      const marzRes = await fetch(`${MARZPAY_BASE_URL}/collect-money/${local.uuid}`, {
        headers: { Authorization: AUTH_HEADER },
      });
      if (marzRes.ok) {
        const marzData = await marzRes.json();
        const status = marzData.data?.transaction?.status || marzData.data?.status;
        if (status) {
          local.status = status;
          transactions.set(reference, local);
        }
      }
    }

    return res.json({ status: 'success', reference, transaction_status: local.status });
  } catch (err) {
    console.error('status error:', err.message);
    return res.status(500).json({ status: 'error', message: 'Could not fetch status' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/payments/webhook
// MarzPay calls this when a collection reaches a final state.
// This endpoint is NOT behind CORS restrictions (server-to-server call),
// but it should not be treated as public — see README for hardening notes.
// ---------------------------------------------------------------------------
app.post('/api/payments/webhook', express.json({ limit: '50kb' }), (req, res) => {
  try {
    const payload = req.body || {};
    const reference = payload?.transaction?.reference;
    const eventType = payload?.event_type;

    if (reference && transactions.has(reference)) {
      const local = transactions.get(reference);
      local.status = payload?.transaction?.status || local.status;
      local.provider_transaction_id = payload?.collection?.provider_transaction_id || null;
      local.event_type = eventType;
      transactions.set(reference, local);

      // TODO: this is where you fulfil the order — mark it paid in your
      // real database, send a confirmation email, release digital goods, etc.
      // Only trust this webhook for FULFILMENT — never trust client-side
      // "payment successful" messages from the browser alone.
      console.log(`Webhook: ${reference} -> ${local.status}`);
    }

    // Always 200 quickly so MarzPay doesn't retry unnecessarily.
    res.sendStatus(200);
  } catch (err) {
    console.error('webhook error:', err.message);
    res.sendStatus(200);
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Payments server listening on port ${PORT} [${NODE_ENV}]`);
});
