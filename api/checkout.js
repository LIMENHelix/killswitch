// Killswitch Websites growth-path multi-select checkout.
// The client posts { phases: ["P1","P3", ...] }; the server maps each phase to
// its MONTHLY subscription price and creates ONE Stripe Checkout Session so the
// customer pays for the whole selection in a single subscription checkout.
// No SDK — calls the Stripe REST API directly via fetch (matches api/chat.js).
// Requires env var STRIPE_SECRET_KEY (already set in the Vercel project).
//
// Prices are looked up server-side by phase code so the client can never set an
// amount. One-time ("or $X once") purchases stay as the per-rung payment links;
// this endpoint only handles the monthly bundle. P0 (free) and P10 (custom) are
// intentionally not buyable here.

// One source of truth for what a module costs and whether it can be sold at all.
// This file used to keep its own copy of the price map, which is how P5 and P6
// stayed purchasable here after being pulled from the pricing page.
import { MONTHLY, isSellable } from '../lib/prices.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    res.status(503).json({ error: 'not_configured' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  const phases = Array.isArray(body.phases) ? body.phases : [];

  // A retired module is refused OUTRIGHT rather than quietly dropped from the
  // basket. Silently ignoring it would charge for the rest of the selection
  // while the customer believed they had bought all of it.
  const retired = phases.filter((p) => MONTHLY[p] && !isSellable(p));
  if (retired.length) {
    res.status(400).json({ error: 'not_for_sale', phases: retired });
    return;
  }

  const priceIds = [];
  const seen = {};
  for (const p of phases) {
    if (!isSellable(p)) continue;
    const id = MONTHLY[p];
    if (id && !seen[id]) { seen[id] = true; priceIds.push(id); }
  }
  if (!priceIds.length) {
    res.status(400).json({ error: 'no_valid_phases' });
    return;
  }

  const host = (req.headers && (req.headers.origin || (req.headers.host && ('https://' + req.headers.host)))) || 'https://killswitchwebsites.com';

  const params = new URLSearchParams();
  params.append('mode', 'subscription');
  params.append('success_url', host + '/pricing?checkout=success');
  params.append('cancel_url', host + '/pricing?checkout=cancel');
  params.append('allow_promotion_codes', 'true');
  params.append('billing_address_collection', 'auto');
  priceIds.forEach((id, i) => {
    params.append('line_items[' + i + '][price]', id);
    params.append('line_items[' + i + '][quantity]', '1');
  });

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.url) {
      console.error('[killswitch checkout] stripe error', r.status, data && data.error);
      res.status(502).json({ error: (data && data.error && data.error.message) || 'stripe_error' });
      return;
    }
    res.status(200).json({ url: data.url });
  } catch (e) {
    console.error('[killswitch checkout] error', e);
    res.status(500).json({ error: 'server_error' });
  }
}
