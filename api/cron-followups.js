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
