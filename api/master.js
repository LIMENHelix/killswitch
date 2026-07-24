// Master Panel backend (operator/customer cockpit). Admin-gated.
// POST /api/master  body: { action, token, ... }
//   action 'list'    -> { accounts:[...], totals:{customers,paying,mrr}, stripe:bool }
//   action 'onboard' -> { ok, email, portalUrl, emailed }  (creates a free account + $0 receipt)
//
// MRR/switch data is read live from Stripe on each load, so it is always
// accurate with no sync to maintain. Free accounts (no Stripe) show plan P0.
import { getAccounts } from '../lib/store.js';
import { onboardCustomer } from '../lib/onboard.js';
import { panelToken } from '../lib/panel-auth.js';

const PRICE_LABEL = {
  price_1ToXlLPmxnF3rtBM5NRurfkt: 'Get Found on Google',
  price_1ToXlrPmxnF3rtBMz3ybz47E: 'Content & Email',
  price_1ToXlsPmxnF3rtBM9Dc9mDul: 'Online Booking',
  price_1ToXltPmxnF3rtBMvKKaw7vx: 'Hosting & Maintenance',
  price_1ToXluPmxnF3rtBMEleF5u3D: 'CRM',
  price_1ToXlvPmxnF3rtBM7aDkUq1Y: 'Marketing Automation',
  price_1ToXlwPmxnF3rtBMfqIS7WEs: 'Payments',
  price_1ToXlyPmxnF3rtBMendZWgMs: 'Analytics',
  price_1ToXlzPmxnF3rtBMv1DlSFC5: '24/7 AI Assistant',
  price_1TnMiMPmxnF3rtBMgqTJpLh6: 'Care Plan',
};

async function stripeGet(path) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const r = await fetch('https://api.stripe.com/v1' + path, {
    headers: { Authorization: 'Bearer ' + key },
  });
  if (!r.ok) { console.error('[master] stripe', path, r.status); return null; }
  return r.json().catch(() => null);
}

// customerId -> { mrr (dollars), switches:[label] } from active subscriptions
async function stripeByCustomer() {
  const out = {};
  const subs = await stripeGet('/subscriptions?status=active&limit=100');
  if (!subs || !Array.isArray(subs.data)) return out;
  for (const s of subs.data) {
    const cust = typeof s.customer === 'string' ? s.customer : (s.customer && s.customer.id);
    if (!cust) continue;
    const rec = (out[cust] = out[cust] || { mrr: 0, switches: [] });
    const items = (s.items && s.items.data) || [];
    for (const it of items) {
      const p = it.price || {};
      const monthly = p.recurring && p.recurring.interval === 'month' ? (p.unit_amount || 0) : 0;
      rec.mrr += monthly / 100;
      const label = PRICE_LABEL[p.id] || (p.nickname || 'Add-on');
      if (!rec.switches.includes(label)) rec.switches.push(label);
    }
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  const authed = [process.env.ADMIN_KEY, process.env.SWITCH_TOKEN].filter(Boolean).includes(body.token);
  if (!authed) { res.status(401).json({ error: 'unauthorized' }); return; }

  const action = body.action || 'list';

  try {
    if (action === 'onboard') {
      const host = (req.headers && (req.headers.origin || (req.headers.host && ('https://' + req.headers.host)))) || 'https://killswitch.domains';
      const out = await onboardCustomer({ email: body.email, site: body.site, name: body.name, host, source: 'master-onboard' });
      if (out.error) { res.status(400).json({ error: out.error }); return; }
      res.status(200).json({ ok: true, email: out.email, portalUrl: out.portalUrl, emailed: out.emailed, tokenReady: out.tokenReady });
      return;
    }

    // action 'list'
    const host = (req.headers && (req.headers.origin || (req.headers.host && ('https://' + req.headers.host)))) || 'https://killswitch.domains';
    const map = await getAccounts();
    const byCust = await stripeByCustomer();
    const accounts = Object.keys(map).map((k) => {
      const a = map[k];
      const s = (a.stripeCustomerId && byCust[a.stripeCustomerId]) || null;
      const tok = panelToken(a.email);
      return {
        email: a.email,
        name: a.name || '',
        site: a.site || '',
        plan: Array.isArray(a.plan) ? a.plan : ['P0'],
        createdAt: a.createdAt || '',
        linked: !!a.stripeCustomerId,
        mrr: s ? +s.mrr.toFixed(2) : 0,
        switches: s ? s.switches : [],
        portalUrl: host + '/panel?e=' + encodeURIComponent(a.email) + (tok ? '&t=' + tok : ''),
      };
    }).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));

    const totals = {
      customers: accounts.length,
      paying: accounts.filter((a) => a.mrr > 0).length,
      mrr: +accounts.reduce((n, a) => n + a.mrr, 0).toFixed(2),
    };
    res.status(200).json({ ok: true, accounts, totals, stripe: !!process.env.STRIPE_SECRET_KEY });
  } catch (e) {
    console.error('[master] error', e);
    res.status(500).json({ error: 'server_error' });
  }
}
