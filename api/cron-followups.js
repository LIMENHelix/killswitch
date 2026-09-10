// Drains the P6 follow-up queue. Vercel cron, every five minutes.
//
// FAILS CLOSED, following the same pattern api/cron-mail.js had to be fixed to
// use: without this the URL is a public trigger that can make us send real email
// on demand. CRON_SECRET is already set on Production for the mailer.
//
// A follow-up is only ever sent for a site whose owner is CURRENTLY paying for
// P6. Checked at send time, not at queue time, because someone can switch the
// module off in the three days between an enquiry and its review request, and
// the honest behaviour is that switching it off stops the sending.
import { claimItem, deadLetter, dueItems, releaseItem, retire, sendItem } from '../lib/automation.js';
import { getSite, has } from '../lib/sites.js';
import { getAccount } from '../lib/store.js';
import { getSuppression } from '../lib/suppression.js';
import { panelToken } from '../lib/panel-auth.js';
import { publicOrigin } from '../lib/origin.js';
import { sendPanelLink } from '../lib/onboard.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const given = (req.headers && req.headers.authorization === 'Bearer ' + secret)
    || (req.query && (req.query.token === process.env.ADMIN_KEY || req.query.token === process.env.SWITCH_TOKEN));
  if (!secret || !given) { res.status(401).json({ error: 'unauthorized' }); return; }

  let items = [];
  try { items = await dueItems(Date.now()); }
  catch (e) { console.error('[cron-followups] read', e); res.status(500).json({ error: 'queue_unreadable' }); return; }

  const out = { due: items.length, sent: 0, skipped: 0, busy: 0, dead: 0, failed: 0, reasons: {} };
  const siteCache = new Map();

  for (const item of items) {
    if (!await claimItem(item.id)) { out.busy++; continue; }
    try {
    let site = siteCache.get(item.slug);
    if (site === undefined) {
      site = await getSite(item.slug).catch(() => null);
      siteCache.set(item.slug, site);
    }

    // THE FREE-SITE CLAIM REMINDER is not a P6 feature: it nudges an owner who
    // was handed a live free site and never opened their panel. Eligibility is
    // re-derived from current durable truth at send time, because any of these
    // can change while the item waited its three days:
    //   claimed/paid/suppressed/site-gone → terminal skip with a recorded reason,
    //   anything else → the existing authenticated panel link goes out once.
    if (item.step === 'claimremind') {
      const skip = async (reason) => {
        await retire(item.id, new Date().toISOString());
        out.skipped++;
        out.reasons[reason] = (out.reasons[reason] || 0) + 1;
      };
      if (!site || !site.published) { await skip('site_gone'); continue; }
      let account = null;
      try { account = await getAccount(String(item.to || '').trim().toLowerCase()); }
      catch (e) { console.error('[cron-followups] claim account', item.id, e); }
      if (!account) { await skip('no_owner'); continue; }
      if (account.engagedAt) { await skip('engaged'); continue; }
      const paid = account.stripeCustomerId
        || (Array.isArray(account.owned) && account.owned.length)
        || (Array.isArray(account.plan) && account.plan.some((p) => p !== 'P0'))
        || (site.modules || []).some((p) => p !== 'P0');
      if (paid) { await skip('paid'); continue; }
      let suppressed = null;
      try { suppressed = await getSuppression({ email: account.email }); }
      catch (e) { console.error('[cron-followups] claim suppression', item.id, e); }
      if (suppressed) { await skip('suppressed'); continue; }

      const tok = await panelToken(account.email);
      const portalUrl = publicOrigin() + '/panel?e=' + encodeURIComponent(account.email) + (tok ? '&t=' + tok : '');
      const sent = tok ? await sendPanelLink({ email: account.email, portalUrl }) : false;
      if (sent) { await retire(item.id, new Date().toISOString()); out.sent++; }
      else {
        out.failed++;
        out.reasons.panel_link = (out.reasons.panel_link || 0) + 1;
      }
      continue;
    }

    // Module off, or the site is gone: drop it rather than leaving it to retry
    // forever. Leaving it queued would send the moment they resubscribed, which
    // is not what "I turned it off" means.
    if (!site || !has(site, 'P6')) {
      await retire(item.id, new Date().toISOString());
      out.skipped++;
      out.reasons.module_off = (out.reasons.module_off || 0) + 1;
      continue;
    }

    const r = await sendItem({ ...item, businessEmail: site.email_public || site.email || '' });
    if (r.sent) { await retire(item.id, new Date().toISOString()); out.sent++; }
    else {
      // A hard rejection is permanent (bad address), so stop retrying it. A
      // missing key is our problem, not theirs, so leave it queued for the run
      // after the key is set.
      out.failed++;
      out.reasons[r.reason] = (out.reasons[r.reason] || 0) + 1;
      if (r.reason && r.reason.startsWith('resend_4')) {
        await deadLetter(item, r.reason);
        await retire(item.id, new Date().toISOString());
        out.dead++;
      }
    }
    } finally {
      await releaseItem(item.id).catch((e) => console.error('[cron-followups] release', item.id, e));
    }
  }

  res.status(out.failed > out.dead ? 500 : 200).json({ ok: out.failed <= out.dead, ...out });
}
