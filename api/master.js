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
import { getSites, upsertSite, slugify } from '../lib/sites.js';

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

// customerId -> { mrr (dollars), switches:[label], renewsAt, endsAt } from active subs.
//
// PAGINATES. Stripe caps a page at 100 and this used to request limit=100 with no
// has_more loop, so past 100 active subscriptions the MRR silently under-reported
// and paying customers rendered as free. It failed quietly, which is the worst
// way to fail. MAX_PAGES bounds the function's runtime; if it is ever hit the
// result is flagged truncated rather than pretending to be complete.
const MAX_PAGES = 25; // 2,500 subscriptions

async function stripeByCustomer() {
  const out = {};
  let startingAfter = null, pages = 0, truncated = false;

  for (;;) {
    const q = '/subscriptions?status=active&limit=100' + (startingAfter ? '&starting_after=' + startingAfter : '');
    const subs = await stripeGet(q);
    if (!subs || !Array.isArray(subs.data)) break;

    for (const s of subs.data) {
      const cust = typeof s.customer === 'string' ? s.customer : (s.customer && s.customer.id);
      if (!cust) continue;
      const rec = (out[cust] = out[cust] || { mrr: 0, switches: [], renewsAt: null, endsAt: null });
      const items = (s.items && s.items.data) || [];
      for (const it of items) {
        const p = it.price || {};
        const monthly = p.recurring && p.recurring.interval === 'month' ? (p.unit_amount || 0) : 0;
        rec.mrr += monthly / 100;
        const label = PRICE_LABEL[p.id] || (p.nickname || 'Add-on');
        if (!rec.switches.includes(label)) rec.switches.push(label);
        // same source api/switch.js uses: Stripe moved period end onto the line item
        const per = it.current_period_end || s.current_period_end || null;
        if (per && (!rec.renewsAt || per < rec.renewsAt)) rec.renewsAt = per;
        // cancel_at_period_end means it is winding down: that date is an END, not a renewal
        if (s.cancel_at_period_end && per && (!rec.endsAt || per < rec.endsAt)) rec.endsAt = per;
      }
    }

    pages++;
    if (!subs.has_more || !subs.data.length) break;
    if (pages >= MAX_PAGES) { truncated = true; break; }
    startingAfter = subs.data[subs.data.length - 1].id;
  }

  Object.defineProperty(out, '__truncated', { value: truncated, enumerable: false });
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
      const host = (req.headers && (req.headers.origin || (req.headers.host && ('https://' + req.headers.host)))) || 'https://killswitchwebsites.com';
      const out = await onboardCustomer({ email: body.email, site: body.site, name: body.name, host, source: 'master-onboard' });
      if (out.error) { res.status(400).json({ error: out.error }); return; }
      res.status(200).json({ ok: true, email: out.email, portalUrl: out.portalUrl, emailed: out.emailed, tokenReady: out.tokenReady });
      return;
    }

    // ---- one-template site records ----
    if (action === 'site-list') {
      const m = await getSites();
      const sites = Object.values(m).map((s) => ({
        slug: s.slug, business: s.business, email: s.email || '', trade: s.trade || '',
        published: !!s.published, modules: s.modules || ['P0'],
      })).sort((a, b) => a.business.localeCompare(b.business));
      res.status(200).json({ ok: true, sites });
      return;
    }
    if (action === 'site-save') {
      const p = body.site || {};
      if (!p.business && !p.slug) { res.status(400).json({ error: 'business_required' }); return; }
      const saved = await upsertSite({
        slug: slugify(p.slug || p.business), email: p.email, business: p.business, trade: p.trade,
        tagline: p.tagline, phone: p.phone, email_public: p.email_public,
        street: p.street, city: p.city, state: p.state, zip: p.zip,
        about: p.about, accent: p.accent, bookingUrl: p.bookingUrl, payUrl: p.payUrl,
        hours: Array.isArray(p.hours) ? p.hours : undefined,
        services: Array.isArray(p.services) ? p.services : undefined,
        posts: Array.isArray(p.posts) ? p.posts : undefined,
        modules: Array.isArray(p.modules) ? p.modules : undefined,
        published: p.published === undefined ? undefined : !!p.published,
      });
      res.status(200).json({ ok: true, site: saved, url: '/s/' + saved.slug });
      return;
    }

    // action 'list'
    const host = (req.headers && (req.headers.origin || (req.headers.host && ('https://' + req.headers.host)))) || 'https://killswitchwebsites.com';
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
        renewsAt: s ? s.renewsAt : null,   // unix seconds, next charge
        endsAt: s ? s.endsAt : null,       // unix seconds, winding down (cancel_at_period_end)
        portalUrl: host + '/panel?e=' + encodeURIComponent(a.email) + (tok ? '&t=' + tok : ''),
      };
    }).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));

    const totals = {
      customers: accounts.length,
      paying: accounts.filter((a) => a.mrr > 0).length,
      mrr: +accounts.reduce((n, a) => n + a.mrr, 0).toFixed(2),
      ending: accounts.filter((a) => a.endsAt).length,
    };
    res.status(200).json({
      ok: true, accounts, totals,
      stripe: !!process.env.STRIPE_SECRET_KEY,
      truncated: !!byCust.__truncated, // true = more subs than we read; MRR is a floor, not a total
    });
  } catch (e) {
    console.error('[master] error', e);
    res.status(500).json({ error: 'server_error' });
  }
}
