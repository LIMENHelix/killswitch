// Stripe webhook. PURELY ADDITIVE: it changes no existing payment path.
//
// The site has twelve buy.stripe.com links, a basket checkout, and the panel.
// All three take money correctly. What only the panel path did was PROVISION:
// create the account, attach the Stripe customer, switch the paid modules on for
// that customer's site, and tell the operator. A no-code payment link cannot do
// any of that, because nothing on our side ever hears about the payment.
//
// This is the ear. Stripe posts here on every successful payment, whichever door
// it came through, and the same provisioning that already works for the panel
// runs for all of them. Nothing else in the codebase changes: the links keep
// working exactly as they do today, they just stop being invisible to us.
//
// SETUP, two clicks in the Stripe dashboard, then one env var:
//   1. Developers > Webhooks > Add endpoint
//      https://killswitchwebsites.com/api/stripe-webhook
//      events: checkout.session.completed, customer.subscription.updated,
//              customer.subscription.deleted, invoice.payment_failed
//   2. copy the signing secret (whsec_...) into Vercel as STRIPE_WEBHOOK_SECRET
//      then redeploy, because Vercel bakes env vars into a deployment
//
// FAILS CLOSED. Without the secret it rejects everything, because an unverified
// webhook is an open endpoint that lets anyone claim a payment happened.
import crypto from 'node:crypto';
import { getAccount, upsertAccount } from '../lib/store.js';
import { panelToken } from '../lib/panel-auth.js';
import { sendPanelLink } from '../lib/onboard.js';
import { notifyOperator, labelPhases } from '../lib/notify.js';
import { PRICE_TO_PHASE } from '../lib/prices.js';
import { liveSubs } from '../lib/entitle.js';
// syncModulesLoud, not syncModules: this is the money path, and a null return
// here meant Stripe charged the card and nothing rendered. See lib/site-link.js.
import { syncModulesLoud } from '../lib/site-link.js';
import { stripeGet } from '../lib/stripe.js';

// Stripe signs the RAW bytes. Any re-serialisation changes them and the
// signature will not match, so the parsed body is useless here.
export const config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Verify Stripe's signature header without the SDK.
 * Header looks like: t=1234567890,v1=abc...,v1=def...
 */
export function verifySignature(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!rawBody || !header || !secret) return false;
  const parts = String(header).split(',').map((p) => p.trim());
  const t = (parts.find((p) => p.startsWith('t=')) || '').slice(2);
  const sigs = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !sigs.length) return false;

  // Replay window. Stripe's own libraries default to five minutes.
  if (Math.abs(nowSec - Number(t)) > 300) return false;

  const expected = crypto.createHmac('sha256', secret)
    .update(t + '.' + rawBody.toString('utf8'), 'utf8')
    .digest('hex');

  // Constant time, and length-checked first because timingSafeEqual throws on a
  // length mismatch rather than returning false.
  return sigs.some((s) => s.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

/** Phases currently billed on a Stripe customer. */
async function phasesFor(customerId) {
  const subs = await liveSubs(customerId);
  const out = new Set();
  for (const s of subs) {
    for (const it of (s.items && s.items.data) || []) {
      const p = PRICE_TO_PHASE[it.price && it.price.id];
      if (p) out.add(p);
    }
  }
  return [...out];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET unset, rejecting');
    res.status(503).json({ error: 'not_configured' });
    return;
  }

  let raw;
  try { raw = await readRaw(req); }
  catch (e) { console.error('[stripe-webhook] body', e); res.status(400).json({ error: 'unreadable' }); return; }

  const sig = req.headers && (req.headers['stripe-signature'] || req.headers['Stripe-Signature']);
  if (!verifySignature(raw, sig, secret)) {
    console.error('[stripe-webhook] bad signature');
    res.status(400).json({ error: 'bad_signature' });
    return;
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch { res.status(400).json({ error: 'bad_json' }); return; }

  // ALWAYS 200 from here on, even when our own handling fails. A non-2xx makes
  // Stripe retry for days, and a bug on our side must not turn into a retry
  // storm. Failures are logged and shown to the operator instead.
  try {
    await handleEvent(event);
  } catch (e) {
    console.error('[stripe-webhook] handling', event && event.type, e);
    await notifyOperator({
      subject: 'Stripe webhook could not be processed',
      heading: 'A payment event arrived but we failed to act on it',
      lines: [`Event: ${(event && event.type) || 'unknown'}`, `Id: ${(event && event.id) || 'unknown'}`,
        'The money is fine, this is our side. Check the customer in Stripe and set them up by hand.'],
      url: 'https://killswitchwebsites.com/master', urlText: 'Open Master Panel',
    });
  }

  res.status(200).json({ received: true });
}

async function handleEvent(event) {
  const type = event && event.type;
  const obj = (event && event.data && event.data.object) || {};

  if (type === 'checkout.session.completed') return onCheckout(obj);
  if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
    return onSubscriptionChange(obj);
  }
  if (type === 'invoice.payment_failed') return onPaymentFailed(obj);
  // Anything else is acknowledged and ignored on purpose.
  return null;
}

/**
 * THE ONE THAT MATTERS. A payment link, the basket, or the panel all end here.
 * The panel path also calls switch.js link(), which is harmless: both do the
 * same upsert and the same module sync, so whichever lands second is a no-op.
 */
async function onCheckout(session) {
  const customer = typeof session.customer === 'string' ? session.customer : (session.customer && session.customer.id);
  const email = String(
    session.customer_email
    || (session.customer_details && session.customer_details.email)
    || '',
  ).trim().toLowerCase();

  if (!email) {
    // A payment link with no email collected. Nothing can be provisioned, so
    // hand it to the operator rather than dropping it.
    await notifyOperator({
      subject: 'PAID with no email address',
      heading: 'Someone paid and Stripe gave us no email',
      lines: [`Stripe customer: ${customer || 'unknown'}`,
        session.amount_total ? `Amount: $${(session.amount_total / 100).toFixed(2)}` : '',
        'Nothing could be set up automatically. Find them in Stripe and onboard them by hand.'].filter(Boolean),
      url: 'https://killswitchwebsites.com/master', urlText: 'Open Master Panel',
    });
    return;
  }

  const existing = await getAccount(email);
  const account = await upsertAccount({
    email,
    ...(existing ? {} : { plan: ['P0'], createdAt: new Date().toISOString(), source: 'stripe-webhook' }),
    ...(customer ? { stripeCustomerId: customer } : {}),
  });

  const phases = customer ? await phasesFor(customer) : [];
  if (phases.length) {
    try { await syncModulesLoud(email, phases, 'stripe-webhook-checkout-completed'); }
    catch (e) { console.error('[stripe-webhook] site sync', e); }
  }

  // They may have bought through a link and never seen a panel, so send it.
  const tok = await panelToken(email);
  const portalUrl = 'https://killswitchwebsites.com/panel?e=' + encodeURIComponent(email) + (tok ? '&t=' + tok : '');
  if (!existing || !existing.stripeCustomerId) {
    try { await sendPanelLink({ email, portalUrl, phases }); }
    catch (e) { console.error('[stripe-webhook] panel link', e); }
  }

  await notifyOperator({
    subject: `PAID - ${account.name || email}`,
    heading: 'A payment came in and was set up automatically',
    lines: [
      `Customer: ${account.name || account.site || email}`,
      `Email: ${email}`,
      session.amount_total ? `Amount: $${(session.amount_total / 100).toFixed(2)}` : '',
      phases.length ? `Switched on: ${labelPhases(phases)}` : 'One-time payment, no modules to switch on.',
      existing ? '' : 'This is a new account, created from the payment.',
    ].filter(Boolean),
    url: 'https://killswitchwebsites.com/master', urlText: 'Open Master Panel',
  });
}

/** Keeps a site in step when a subscription changes outside the panel. */
async function onSubscriptionChange(sub) {
  const customer = typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id);
  if (!customer) return;

  let email = '';
  const cust = await stripeGet('/customers/' + encodeURIComponent(customer));
  if (cust && cust.email) email = String(cust.email).trim().toLowerCase();
  if (!email) return;

  const account = await getAccount(email);
  if (!account) return;

  const phases = await phasesFor(customer);
  try { await syncModulesLoud(email, phases, 'stripe-webhook-subscription-changed'); }
  catch (e) { console.error('[stripe-webhook] sync', e); }
}

async function onPaymentFailed(invoice) {
  const email = String(invoice.customer_email || '').trim().toLowerCase();
  await notifyOperator({
    subject: `Payment FAILED - ${email || 'a customer'}`,
    heading: 'A card was declined',
    lines: [
      email ? `Email: ${email}` : `Stripe customer: ${invoice.customer || 'unknown'}`,
      invoice.amount_due ? `Amount: $${(invoice.amount_due / 100).toFixed(2)}` : '',
      'Stripe will retry on its own schedule. Their modules stay on in the meantime, because past_due still counts as a live customer.',
    ].filter(Boolean),
    url: 'https://killswitchwebsites.com/master', urlText: 'Open Master Panel',
  });
}
