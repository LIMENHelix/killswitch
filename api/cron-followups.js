// Drains the P6 follow-up queue. Vercel cron, every five minutes.
//
// FAILS CLOSED on CRON_SECRET Bearer only. No query-token fallback. This cron
// sends real email; the URL must not be triggerable without the project secret.
import { claimItem, deadLetter, dueItems, MAX_SEND_ATTEMPTS, recordAttempt, recordLastRun, releaseItem, retire, sendItem } from '../lib/automation.js';
import { getSite, has } from '../lib/sites.js';
import { getAccount } from '../lib/store.js';
import { getSuppression } from '../lib/suppression.js';
import { panelToken } from '../lib/panel-auth.js';
import { publicOrigin } from '../lib/origin.js';
import { sendPanelLink } from '../lib/onboard.js';
import { cronAuthorized } from '../lib/cron-auth.js';

// The work, separated from the auth so the owner can also trigger it through
// /api/admin action:run-followups. The cron URL itself stays bearer-only.
export async function drainFollowups() {
  let items = [];
  try { items = await dueItems(Date.now()); }
  catch (e) { console.error('[cron-followups] read', e); return { code: 500, body: { error: 'queue_unreadable' } }; }

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
      // The provider idempotency identity is the queue id: a retry after
      // "provider accepted but this function died before retiring" must dedupe
      // at Resend instead of delivering a second identical reminder.
      const r = tok
        ? await sendPanelLink({ email: account.email, portalUrl, idempotencyKey: 'ks-claimremind/' + item.id }, { report: true })
        : { sent: false, reason: 'panel_link' };
      if (r.sent) { await retire(item.id, new Date().toISOString()); out.sent++; continue; }
      out.failed++;
      out.reasons[r.reason] = (out.reasons[r.reason] || 0) + 1;
      if (r.reason && r.reason.startsWith('resend_4')) {
        // Permanent provider rejection (bad address): terminal, same policy as P6.
        await deadLetter(item, r.reason);
        await retire(item.id, new Date().toISOString());
        out.dead++;
      } else if (r.reason === 'threw' || (r.reason && r.reason.startsWith('resend_5'))) {
        // Transient: bounded retry, then terminal dead-letter — never an
        // indefinite five-minute loop.
        const attempts = await recordAttempt(item);
        if (attempts >= MAX_SEND_ATTEMPTS) {
          await deadLetter({ ...item, attempts }, 'retry_budget_exhausted');
          await retire(item.id, new Date().toISOString());
          out.dead++;
        }
      }
      // preview_side_effects_disabled / no_api_key: configuration, not the
      // recipient — leave queued exactly like the P6 path does.
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
      } else if (r.reason === 'threw' || (r.reason && r.reason.startsWith('resend_5'))) {
        // Transient: bounded retry, then terminal dead-letter — the same
        // policy the claim-reminder branch applies, so a persistently failing
        // provider can never spin the five-minute cron indefinitely.
        const attempts = await recordAttempt(item);
        if (attempts >= MAX_SEND_ATTEMPTS) {
          await deadLetter({ ...item, attempts }, 'retry_budget_exhausted');
          await retire(item.id, new Date().toISOString());
          out.dead++;
        }
      }
    }
    } finally {
      await releaseItem(item.id).catch((e) => console.error('[cron-followups] release', item.id, e));
    }
  }

  await recordLastRun(out);
  return { code: out.failed > out.dead ? 500 : 200, body: { ok: out.failed <= out.dead, ...out } };
}

export default async function handler(req, res) {
  if (!cronAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const r = await drainFollowups();
  res.status(r.code).json(r.body);
}
