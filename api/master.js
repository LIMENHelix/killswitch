// Master Panel backend (operator/customer cockpit). Admin-gated.
// POST /api/master  body: { action, token, ... }
//   action 'list'    -> { accounts:[...], totals:{customers,paying,mrr}, stripe:bool }
//   action 'onboard' -> { ok, email, portalUrl, emailed }  (creates a free account + $0 receipt)
//
// MRR/switch data is read live from Stripe on each load, so it is always
// accurate with no sync to maintain. Free accounts (no Stripe) show plan P0.
import crypto from 'node:crypto';
import { getAccounts, saveAccounts, upsertAccount, getLeads, setLeadMetaMany } from '../lib/store.js';
import { draftFromLead } from '../lib/draft-site.js';
import { writeSite } from '../lib/site-writer.js';

// Bulk draft generation writes hundreds of records per call.
export const config = { maxDuration: 60 };
import { onboardCustomer } from '../lib/onboard.js';
import { signPanel } from '../lib/panel-auth.js';
import { identify, isOwner } from '../lib/roles.js';
import { listSites, getSite, upsertSite, bulkUpsert, migrateAll, slugify } from '../lib/sites.js';

// Everything the website editor is allowed to write. A save applies ONLY the
// keys it was actually sent, so a partial save is a partial update. This used to
// pass all of them unconditionally, and site-list returns a summary rather than
// the full record, so opening an existing customer and saving wrote blanks over
// their phone, address, hours, services and about text. Use site-get to load.
const SITE_FIELDS = [
  'email', 'business', 'trade', 'tagline', 'phone', 'email_public',
  'street', 'city', 'state', 'zip', 'about', 'accent', 'bookingUrl', 'payUrl',
];
const SITE_ARRAYS = ['hours', 'services', 'posts', 'modules'];

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
  const byEmail = {}; // lowercased email -> stripe customer id, for self-healing
  let startingAfter = null, pages = 0, truncated = false;

  for (;;) {
    // expand the customer so we get their email in the SAME call. That is what
    // lets us repair an account whose payment was never linked, at no extra cost.
    const q = '/subscriptions?status=active&limit=100&expand[]=data.customer' + (startingAfter ? '&starting_after=' + startingAfter : '');
    const subs = await stripeGet(q);
    if (!subs || !Array.isArray(subs.data)) break;

    for (const s of subs.data) {
      const cust = typeof s.customer === 'string' ? s.customer : (s.customer && s.customer.id);
      if (!cust) continue;
      const cEmail = (s.customer && typeof s.customer === 'object' && s.customer.email) ? String(s.customer.email).trim().toLowerCase() : '';
      if (cEmail && !byEmail[cEmail]) byEmail[cEmail] = cust;
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
  Object.defineProperty(out, '__byEmail', { value: byEmail, enumerable: false });
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  // OWNER ONLY, stated in one place. This screen carries every customer's email,
  // their revenue, and a working private portal link that flips their billing, so
  // a rep key must never open it even if one is added to the env by mistake.
  if (!isOwner(identify(body.token))) { res.status(401).json({ error: 'unauthorized' }); return; }

  const action = body.action || 'list';

  try {
    if (action === 'onboard') {
      const host = (req.headers && (req.headers.origin || (req.headers.host && ('https://' + req.headers.host)))) || 'https://killswitchwebsites.com';
      const out = await onboardCustomer({ email: body.email, site: body.site, name: body.name, host, source: 'master-onboard' });
      if (out.error) { res.status(400).json({ error: out.error }); return; }

      // Handing over the free site is the moment they become a customer, so the
      // site gets their email, goes live, and becomes CLAIMED, which is the only
      // state search engines are allowed to index. Everything before this is a
      // page about a business that agreed to nothing.
      let claimed = null;
      if (body.slug) {
        try { claimed = await upsertSite({ slug: body.slug, email: out.email, published: true, claimed: true }); }
        catch (e) { console.error('[master] claim site', e); }
      }
      res.status(200).json({
        ok: true, email: out.email, portalUrl: out.portalUrl, emailed: out.emailed,
        tokenReady: out.tokenReady, claimedSlug: claimed ? claimed.slug : null,
      });
      return;
    }

    // ---- one-template site records ----
    // Summaries only, filtered and paged on the server. Once there are thousands
    // of drafts, shipping the whole set to the browser on every load is the same
    // mistake in a new place.
    if (action === 'site-list') {
      const all = await listSites();
      const counts = {
        all: all.length,
        published: all.filter((s) => s.published).length,
        drafts: all.filter((s) => !s.published).length,
      };
      const q = String(body.q || '').toLowerCase().trim();
      let sites = all;
      if (q) sites = sites.filter((s) => (s.business || '').toLowerCase().includes(q)
        || (s.slug || '').includes(q) || (s.city || '').toLowerCase().includes(q));
      if (body.published !== undefined) sites = sites.filter((s) => !!s.published === !!body.published);
      if (body.source === 'draft-bulk') sites = sites.filter((s) => s.source === 'draft-bulk');
      if (body.source === 'hand') sites = sites.filter((s) => s.source !== 'draft-bulk');

      const total = sites.length;
      const offset = Math.max(0, Number(body.offset) || 0);
      const limit = Math.min(Math.max(1, Number(body.limit) || 100), 500);
      sites = sites.sort((a, b) => String(a.business || '').localeCompare(String(b.business || '')))
        .slice(offset, offset + limit);
      res.status(200).json({ ok: true, sites, total, counts, offset, limit });
      return;
    }

    // One-time move off the single ks:sites blob. Safe to run again; the old blob
    // is left in place as a backup rather than deleted.
    if (action === 'site-migrate') {
      res.status(200).json({ ok: true, ...(await migrateAll()) });
      return;
    }

    // Generate DRAFT sites from leads, in batches the browser drives to completion.
    // Drafts are unpublished, which api/site.js serves as a 404, so nothing here
    // is visible to the business, to Google, or to a URL guess until published.
    if (action === 'site-bulk-draft') {
      const limit = Math.min(Math.max(1, Number(body.limit) || 100), 400);
      const [leads, idx] = await Promise.all([getLeads(), listSites()]);
      const taken = new Set(idx.map((s) => s.slug));
      const already = new Set(idx.map((s) => s.leadId).filter(Boolean));

      let noId = 0;
      const pool = leads.filter((l) => {
        if (!l.name) return false;
        if (!l.id) { noId++; return false; }
        if (already.has(l.id)) return false;
        if (body.trade && l.trade !== body.trade) return false;
        if (body.state && l.state !== body.state) return false;
        return true;
      });

      const batch = pool.slice(0, limit);
      const recs = batch.map((l) => draftFromLead(l, taken)).filter(Boolean);
      if (recs.length) {
        await bulkUpsert(recs);
        // Stamp the slug back onto the lead so the postcard and the call script
        // can print the URL of the site that is already waiting for them.
        await setLeadMetaMany(recs.map((r) => [r.leadId, { siteSlug: r.slug }]));
      }
      res.status(200).json({
        ok: true, created: recs.length,
        remaining: Math.max(0, pool.length - batch.length),
        skippedNoId: noId, totalLeads: leads.length,
      });
      return;
    }
    // The FULL record, for loading into the editor. Without this the editor can
    // only ever be used to create, because everything it did not receive it
    // silently blanked on the next save.
    if (action === 'site-get') {
      const s = await getSite(body.slug);
      if (!s) { res.status(404).json({ error: 'not_found' }); return; }
      res.status(200).json({ ok: true, site: s });
      return;
    }

    // Write this business its own website, from a prompt about that business.
    // The generated page replaces the template for this slug only; every other
    // site is untouched, so upgrading one customer never moves anyone else.
    if (action === 'site-write') {
      const s = await getSite(body.slug);
      if (!s) { res.status(404).json({ error: 'not_found' }); return; }
      const out = await writeSite(s, { extra: body.extra });
      if (!out.ok) { res.status(502).json({ error: 'write_failed', message: out.error }); return; }
      const saved = await upsertSite({ slug: s.slug, html: out.html, htmlAt: new Date().toISOString() });
      res.status(200).json({ ok: true, bytes: out.bytes, url: '/s/' + saved.slug, htmlAt: saved.htmlAt });
      return;
    }

    // Drop a generated page and fall back to the shared template for this site.
    if (action === 'site-unwrite') {
      const s = await getSite(body.slug);
      if (!s) { res.status(404).json({ error: 'not_found' }); return; }
      await upsertSite({ slug: s.slug, html: '', htmlAt: '' });
      res.status(200).json({ ok: true });
      return;
    }

    // Approve or discard what the voice agent suggested but could not confirm.
    // Approving merges it into the record; discarding drops it. Either way the
    // proposal is cleared, so nothing sits in limbo pretending to be reviewed.
    if (action === 'site-proposed-resolve') {
      const s = await getSite(body.slug);
      if (!s) { res.status(404).json({ error: 'not_found' }); return; }
      const proposed = s.proposed || {};
      if (!Object.keys(proposed).length) { res.status(200).json({ ok: true, applied: [], note: 'nothing pending' }); return; }

      const patch = { proposed: {}, proposedNote: '' };
      let applied = [];
      if (body.approve) {
        const fields = Array.isArray(body.fields) && body.fields.length ? body.fields : Object.keys(proposed);
        for (const f of fields) if (proposed[f] !== undefined) { patch[f] = proposed[f]; applied.push(f); }
      }
      const saved = await upsertSite({ slug: s.slug, ...patch });
      res.status(200).json({ ok: true, applied, site: saved });
      return;
    }

    if (action === 'site-save') {
      const p = body.site || {};
      if (!p.business && !p.slug) { res.status(400).json({ error: 'business_required' }); return; }

      const patch = { slug: slugify(p.slug || p.business) };
      for (const f of SITE_FIELDS) if (Object.prototype.hasOwnProperty.call(p, f)) patch[f] = p[f];
      for (const f of SITE_ARRAYS) if (Array.isArray(p[f])) patch[f] = p[f];
      if (p.published !== undefined) patch.published = !!p.published;
      if (p.claimed !== undefined) patch.claimed = !!p.claimed;

      const saved = await upsertSite(patch);
      res.status(200).json({ ok: true, site: saved, url: '/s/' + saved.slug });
      return;
    }

    // action 'list'
    const host = (req.headers && (req.headers.origin || (req.headers.host && ('https://' + req.headers.host)))) || 'https://killswitchwebsites.com';
    const map = await getAccounts();
    const byCust = await stripeByCustomer();

    // SELF-HEAL. A customer who paid and then closed the tab never came back to
    // success_url, so api/switch.js link() never ran and their account still says
    // free while Stripe charges them. Stripe just told us which emails hold an
    // active subscription, so any account that matches one and is not linked gets
    // linked now, before this page renders a number that would be wrong.
    const repaired = [];
    for (const k of Object.keys(map)) {
      const a = map[k];
      if (a.stripeCustomerId) continue;
      const cust = byCust.__byEmail[String(a.email || '').trim().toLowerCase()];
      if (!cust) continue;
      a.stripeCustomerId = cust;
      repaired.push(upsertAccount({ email: a.email, stripeCustomerId: cust }));
    }
    if (repaired.length) {
      await Promise.all(repaired);
      console.log('[master] linked', repaired.length, 'account(s) whose payment was never recorded');
    }

    // Accounts created before token nonces existed have none, and my first pass
    // simply emitted no token for them. That produced a /panel URL with no
    // access code, which the panel could not authenticate, so it fell back to
    // its built-in defaults and showed paid switches as ON for accounts that
    // were paying for nothing. Mint the missing nonces instead. A write is
    // legitimate here because this route is owner-authenticated; the public
    // verify path still never writes. One save for the whole batch.
    const needNonce = Object.keys(map).filter((k) => !map[k].tokenNonce);
    if (needNonce.length) {
      for (const k of needNonce) map[k].tokenNonce = crypto.randomBytes(9).toString('hex');
      await saveAccounts(map);
      console.log('[master] minted portal nonces for', needNonce.length, 'account(s)');
    }

    const accounts = Object.keys(map).map((k) => {
      const a = map[k];
      const s = (a.stripeCustomerId && byCust[a.stripeCustomerId]) || null;
      // Sync, because this runs inside a .map over every account.
      const tok = signPanel(a.email, a.tokenNonce, Date.now() + 90 * 86400000);
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
