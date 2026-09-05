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
import { onboardCustomer, sendPanelLink } from '../lib/onboard.js';
import { signPanel, panelToken } from '../lib/panel-auth.js';
import { identify, isOwner } from '../lib/roles.js';
import { listSites, getSite, upsertSite, bulkUpsert, migrateAll, slugify, siteForEmail, siteSlugsByEmail, deleteSite } from '../lib/sites.js';
import { linkAccountToSite } from '../lib/site-link.js';
import { rerootRelativeUrls } from '../lib/site-modules.js';
import { publicOrigin } from '../lib/origin.js';
import { getLifecycleEvents, getLifecycleStates, recordLifecycle } from '../lib/lifecycle.js';
import { completeWorkOrder, listWorkOrders, markWorkOrderNotified } from '../lib/work-orders.js';
import { notifyCustomer } from '../lib/notify.js';
import { listBillingEvents } from '../lib/billing-events.js';
import { collectWeeklyScorecard } from '../lib/scorecard.js';

// Everything the website editor is allowed to write. A save applies ONLY the
// keys it was actually sent, so a partial save is a partial update. This used to
// pass all of them unconditionally, and site-list returns a summary rather than
// the full record, so opening an existing customer and saving wrote blanks over
// their phone, address, hours, services and about text. Use site-get to load.
const SITE_FIELDS = [
  'email', 'business', 'trade', 'tagline', 'phone', 'email_public',
  'street', 'city', 'state', 'zip', 'about', 'accent', 'googleBusinessProfile', 'bookingUrl', 'payUrl',
];
const SITE_ARRAYS = ['hours', 'services', 'posts', 'modules'];

/**
 * Which of the things that fail QUIETLY are actually configured.
 *
 * Every one of these is read at the moment it is needed and, when missing,
 * logs and returns rather than throwing: notify.js skips the mail, panel-auth
 * returns no token. So a purchase alert that never arrives and a portal link
 * that will not open look identical to nothing having happened. This is the
 * only place that says so out loud.
 *
 * Reports PRESENCE, never a value. This response goes to a browser.
 */
function configReport() {
  const need = {
    RESEND_API_KEY: 'send the portal link and every purchase alert',
    KS_NOTIFY_EMAIL: 'the address purchase alerts are sent to',
    KS_PANEL_SECRET: 'sign panel links, without which no customer can open their panel',
    STRIPE_SECRET_KEY: 'read subscriptions and start a checkout',
    STRIPE_WEBHOOK_SECRET: 'trust what Stripe says about a payment',
  };
  const missing = Object.keys(need).filter((k) => !String(process.env[k] || '').trim());
  return { ok: !missing.length, missing, why: need };
}

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
    if (action === 'scorecard') {
      res.status(200).json({ ok: true, report: await collectWeeklyScorecard() });
      return;
    }

    if (action === 'billing-events') {
      const events = await listBillingEvents({ limit: body.limit });
      res.status(200).json({
        ok: true,
        events: events.filter((event) => event.type !== 'payment.completed' && !event.type.startsWith('customer.subscription.')),
      });
      return;
    }

    if (action === 'work-list') {
      res.status(200).json({ ok: true, orders: await listWorkOrders(body.limit) });
      return;
    }

    if (action === 'work-complete') {
      const result = await completeWorkOrder(body.id, body.note);
      if (!result) { res.status(404).json({ error: 'work_order_not_found' }); return; }
      const order = result.order;
      await recordLifecycle(order.email, {
        type: 'service.completed', stage: 'service_completed', blocked: false,
        idempotencyKey: 'work-order:' + order.id + ':completed',
        data: { workOrderId: order.id, site: order.site || '' },
      });
      let notice = { sent: !!order.customerNotifiedAt, reason: order.customerNotifiedAt ? 'already_sent' : '' };
      if (!order.customerNotifiedAt) {
        notice = await notifyCustomer({
          to: order.email,
          subject: `Your website update is complete${order.name ? ' - ' + order.name : ''}`,
          heading: 'Your requested website work is complete',
          lines: [
            order.name ? `Customer: ${order.name}` : '',
            order.completionNote || 'The website change you requested has been completed.',
            'Open your website and reply to this email if anything still needs attention.',
          ].filter(Boolean),
          url: order.site && order.site.startsWith('/') ? publicOrigin() + order.site : '',
          urlText: 'Open your website',
          idempotencyKey: 'work-order-complete-' + order.id,
        });
        if (notice.sent) await markWorkOrderNotified(order.id);
      }
      res.status(200).json({ ok: true, order, duplicate: result.duplicate, notified: !!notice.sent, notifyReason: notice.reason || '' });
      return;
    }

    if (action === 'lifecycle-events') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) { res.status(400).json({ error: 'valid_email_required' }); return; }
      res.status(200).json({ ok: true, email, events: await getLifecycleEvents(email, body.limit) });
      return;
    }

    if (action === 'onboard') {
      const host = publicOrigin();
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

    // ---- hand a business their site, in one call ----
    //
    // Every step of this existed and none of them were joined up, which is why
    // no customer site had ever gone live: the demo pages are static files that
    // /s/<slug> knows nothing about, `html` was not a savable field, publishing
    // and claiming were separate ticks, and onboarding was a different screen
    // again. Four correct actions in the wrong order leaves a customer with a
    // panel controlling a 404, so this does the whole chain or reports which
    // part of it failed.
    //
    // The HTML is POSTED here rather than read from disk. /demos/*.html are
    // static files Vercel serves directly and does not bundle into this
    // function, so fs would find nothing at runtime; the browser fetches the
    // page it can already see and sends it.
    if (action === 'site-golive') {
      const slug = slugify(body.slug || body.business || '');
      if (!slug) { res.status(400).json({ error: 'slug_or_business_required' }); return; }
      let html = String(body.html || '');
      let patchSrc = '';
      if (html && html.length > 900000) { res.status(400).json({ error: 'html_too_large' }); return; }

      // THE SAME BYTES AT A NEW ADDRESS ARE NOT THE SAME PAGE. A page built at
      // /demos/x can say src="assets/logo.jpg" and be correct; served from /s/x
      // the browser resolves that against /s/ and the business's own logo 404s
      // off their website with no error anywhere. Re-root it once, here, so
      // what gets stored is right rather than right-only-where-it-came-from.
      if (html && body.src) html = rerootRelativeUrls(html, String(body.src));
      if (body.src) patchSrc = String(body.src);

      const host = publicOrigin();
      const out = { slug, url: host + '/s/' + slug, steps: {}, config: configReport() };

      // 1. The page itself. Publishing a record with no content would put a
      //    blank page up under a real business's name, so an empty html with no
      //    existing page is refused rather than published.
      const before = await getSite(slug);
      if (!html && !(before && before.html)) { res.status(400).json({ error: 'no_html_to_publish' }); return; }
      // PUBLISHED IS NOT CLAIMED, AND THIS USED TO SET BOTH AT ONCE.
      //
      // The record has three states, not two, and the middle one is the whole
      // point: published:true, claimed:false is reachable by its own link and
      // carries noindex, so the owner can open what we built while Google never
      // sees it. Setting both together skipped that and put a business's name
      // on an indexable page before they had agreed to anything. An owner who
      // then goes quiet for days leaves it there.
      //
      // So claim is now a separate, deliberate act: site-claim, after they say
      // yes. An omitted `claim` leaves the existing value alone, so re-running
      // this to fix a page never silently un-claims a customer who did accept.
      const patch = { slug, published: true };
      if (body.claim !== undefined) patch.claimed = !!body.claim;
      if (patchSrc) patch.htmlSrc = patchSrc;
      if (html) patch.html = html;
      if (body.email) patch.email = String(body.email).trim().toLowerCase();
      if (body.business) patch.business = String(body.business).trim();
      const saved = await upsertSite(patch);
      out.steps.site = { ok: true, published: saved.published, claimed: saved.claimed, bytes: (saved.html || '').length };

      // 2. The customer. onboardCustomer mints the panel token and mails them
      //    the link, and linkAccountToSite joins the account to the record we
      //    just wrote. Optional: publishing a site and handing it over are two
      //    different decisions and this supports doing only the first.
      if (body.email) {
        try {
          const on = await onboardCustomer({
            email: body.email, site: saved.business || slug, name: body.name, host, source: 'master-golive',
          });
          out.steps.customer = on.error
            ? { ok: false, error: on.error }
            : { ok: true, email: on.email, portalUrl: on.portalUrl, emailed: on.emailed, tokenReady: on.tokenReady, link: on.link };
        } catch (e) {
          console.error('[master] golive onboard', e);
          out.steps.customer = { ok: false, error: 'onboard_threw' };
        }
      }

      res.status(200).json({ ok: true, ...out });
      return;
    }

    // Which switches can actually be flipped, and whether the things that fail
    // SILENTLY are configured. A missing RESEND_API_KEY does not throw anywhere:
    // notify.js logs and returns, so purchase alerts and portal links simply
    // never arrive and nothing on any screen says so.
    // ---- send someone their panel link again, and PROVE it will work ----
    //
    // "Resend" on its own is the easy half and the useless half. A link that
    // opens a panel whose switches drive nothing is worse than no link, because
    // the customer now believes they have control. So this does not report what
    // it thinks is true: it READS the join, and if the join is missing it tries
    // to make it and then reads it AGAIN to see whether that worked.
    //
    // Two separate things have to hold before their switches do anything, and
    // they fail independently, so both are reported rather than collapsed into
    // one green tick: the account has to be joined to a site record, and that
    // record has to be published, or /s/<slug> is a 404 by design.
    if (action === 'resend-portal') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!email || email.indexOf('@') < 1) { res.status(400).json({ error: 'valid_email_required' }); return; }
      const map = await getAccounts();
      const acct = map[email];
      if (!acct) { res.status(404).json({ error: 'no_such_account' }); return; }

      const host = publicOrigin();
      const out = { email, repaired: false, reason: '' };

      let site = await siteForEmail(email);
      if (!site) {
        // Not attached. Try to attach it from what the account already knows,
        // then look again rather than trusting the attempt's own word for it.
        const link = await linkAccountToSite({ email, site: acct.site, name: acct.name });
        out.reason = link.reason;
        if (link.linked) { site = await siteForEmail(email); out.repaired = !!site; }
      }

      out.attached = !!site;
      out.site = site
        ? { slug: site.slug, published: !!site.published, claimed: !!site.claimed, modules: site.modules || [] }
        : null;
      // The one thing worth reading: will a switch they flip change anything.
      out.working = !!(site && site.published);

      const tok = await panelToken(email);
      out.tokenReady = !!tok;
      out.portalUrl = host + '/panel?e=' + encodeURIComponent(email) + (tok ? '&t=' + tok : '');
      // Re-minting reuses the account's existing nonce, so every link already
      // sent keeps working until its own expiry. A resend adds a link, it does
      // not revoke one, which matters when they may be mid-signup on the old.
      out.sent = tok ? await sendPanelLink({ email, portalUrl: out.portalUrl, phases: acct.plan || [] }) : false;

      res.status(200).json({ ok: true, ...out, config: configReport() });
      return;
    }

    // ---- take a site down, and prove it is down ----
    //
    // Two different asks, so two different actions rather than one that guesses.
    // UNPUBLISH is the one you want when someone says "get it off the internet
    // now": it is instant, it is a hard 404, and everything they said and every
    // page we built is still there when the conversation goes the other way.
    // DELETE is for when it is genuinely over.
    //
    // Unpublishing also drops claimed, because claimed is the flag that permits
    // indexing. A page taken down at the owner's request must not stay eligible
    // to be indexed if it is ever republished by accident.
    // ---- they said yes: let it be indexed ----
    //
    // The second half of the split. Claiming is the only thing that removes
    // noindex, so it is the one irreversible-in-public step and it gets its own
    // action rather than riding along with publishing. Reversible: passing
    // claimed:false puts the noindex back for a customer who changes their mind.
    if (action === 'site-claim') {
      const slug = slugify(body.slug || '');
      if (!slug) { res.status(400).json({ error: 'slug_required' }); return; }
      const before = await getSite(slug);
      if (!before) { res.status(404).json({ error: 'not_found' }); return; }
      const want = body.claimed === undefined ? true : !!body.claimed;
      // Claiming something nobody can reach is meaningless, and would leave a
      // record marked accepted that serves a 404.
      if (want && !before.published) { res.status(400).json({ error: 'publish_it_first' }); return; }
      const saved = await upsertSite({ slug, claimed: want });
      res.status(200).json({
        ok: true, slug, business: saved.business || '',
        published: !!saved.published, claimed: !!saved.claimed,
        indexable: !!(saved.published && saved.claimed),
        url: '/s/' + slug,
      });
      return;
    }

    if (action === 'site-unpublish') {
      const slug = slugify(body.slug || '');
      if (!slug) { res.status(400).json({ error: 'slug_required' }); return; }
      const before = await getSite(slug);
      if (!before) { res.status(404).json({ error: 'not_found' }); return; }
      const saved = await upsertSite({ slug, published: false, claimed: false });
      res.status(200).json({
        ok: true, slug, business: saved.business || '',
        published: !!saved.published, claimed: !!saved.claimed,
        keptPage: !!(saved.html && saved.html.length),
        url: '/s/' + slug,
      });
      return;
    }

    if (action === 'site-delete') {
      const slug = slugify(body.slug || '');
      if (!slug) { res.status(400).json({ error: 'slug_required' }); return; }
      // Deleting a customer's website is not undoable from this screen, so it
      // does not happen on a single mistyped field: the caller has to name the
      // slug twice, the way the button in /master does after asking.
      if (slugify(body.confirm || '') !== slug) { res.status(400).json({ error: 'confirm_must_match_slug' }); return; }
      const out = await deleteSite(slug);
      if (!out.deleted) { res.status(404).json(out); return; }
      res.status(200).json({ ok: true, ...out });
      return;
    }

    if (action === 'preflight') {
      res.status(200).json({ ok: true, config: configReport() });
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
      // THE PAGE ITSELF. Deliberately not in SITE_FIELDS: those are applied by
      // presence, and one caller that forgot the key would blank a customer's
      // entire website. This writes only when a string was actually sent, and
      // an empty string is a real instruction meaning "go back to the template".
      //
      // Without this the editor was a lie on any site with its own page:
      // api/site.js serves site.html verbatim and only falls back to the
      // template when it is empty, so editing the business name, phone, hours
      // or address changed the record and changed nothing anybody could see.
      if (typeof p.html === 'string') patch.html = p.html;

      const saved = await upsertSite(patch);
      res.status(200).json({ ok: true, site: saved, url: '/s/' + saved.slug });
      return;
    }

    // action 'list'
    const host = publicOrigin();
    const [map, lifecycleByEmail] = await Promise.all([getAccounts(), getLifecycleStates()]);
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

    // WHO IS ACTUALLY ATTACHED TO A WEBSITE. Two reads for the whole list
    // rather than one per account: the join hash, and the site summaries that
    // carry published/claimed. Without this the screen shows a portal link for
    // every account and says nothing about whether that panel drives anything,
    // which is exactly how a customer ends up holding a link to a 404.
    let joinByEmail = {};
    let siteBySlug = {};
    try {
      joinByEmail = await siteSlugsByEmail();
      for (const s of await listSites()) siteBySlug[s.slug] = s;
    } catch (e) { console.error('[master] join lookup', e); }

    const accounts = Object.keys(map).map((k) => {
      const a = map[k];
      const s = (a.stripeCustomerId && byCust[a.stripeCustomerId]) || null;
      const slug = joinByEmail[String(a.email || '').trim().toLowerCase()] || '';
      const rec = slug ? siteBySlug[slug] : null;
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
        // Attached is the join; working is whether a switch they flip can
        // change anything. A published:false record is a hard 404 in
        // api/site.js, so attached-but-unpublished is still a dead panel.
        siteSlug: slug,
        attached: !!rec,
        working: !!(rec && rec.published),
        lifecycle: lifecycleByEmail[String(a.email || '').trim().toLowerCase()] || null,
      };
    }).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));

    const totals = {
      customers: accounts.length,
      paying: accounts.filter((a) => a.mrr > 0).length,
      mrr: +accounts.reduce((n, a) => n + a.mrr, 0).toFixed(2),
      ending: accounts.filter((a) => a.endsAt).length,
      attention: accounts.filter((a) => a.lifecycle && (a.lifecycle.status === 'blocked' || a.lifecycle.stage === 'integrations_required')).length,
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
