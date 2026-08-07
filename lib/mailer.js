// Shared Lob send + the autopilot batch engine. Used by /api/admin (manual
// "approve & mail") and /api/cron-mail (scheduled auto-send). Nothing here runs
// unless config.enabled is true AND under the daily cap AND under the budget.

import { getLeads, saveLeads, getConfig, saveConfig, getLeadMeta } from './store.js';
import { frontHtml, backHtml } from './postcard.js';
import { notifyOperator } from './notify.js';
import { getSite, upsertSite } from './sites.js';

export const COST = 0.94;                 // approx per 6x9 postcard, USD
const PER_RUN = 50;                       // hard ceiling per single run (function-time safety)
const ATTEMPT_CAP = 400;                  // bound Lob calls even if many bad addresses

export function hasAddr(l) { return !!(l.street && l.state && l.zip); }
export function isMailed(l) { return l.status === 'mailed' || !!l.lob_id; }
// budgetCeiling is a LIFETIME postage ceiling, so what has already been mailed
// (by autopilot or by hand) counts against it. One place computes it.
export function spentToDate(leads) { return +((leads.filter(isMailed).length) * COST).toFixed(2); }
export function isBad(l) { return l.status === 'bad_address'; }
export function inQueue(l) { return hasAddr(l) && !isMailed(l) && !isBad(l); }

/**
 * A postcard that prints a URL must find a live page at it, so publishing the
 * draft is part of putting the card in the mail. It goes live UNCLAIMED, which
 * means noindex: the owner can open the link we sent them, and Google never
 * indexes a page branded with a business that has not agreed to anything.
 * Fails soft: no draft, or any error, and the card falls back to the plain offer.
 */
async function publishForMail(lead) {
  if (!lead.siteSlug) return '';
  try {
    const s = await getSite(lead.siteSlug);
    if (!s) return '';
    if (!s.published) await upsertSite({ slug: s.slug, published: true });
    return 'killswitchwebsites.com/s/' + s.slug;
  } catch (e) { console.error('[mailer] publish for mail', lead.siteSlug, e); return ''; }
}

export async function lobSend(lead) {
  const key = process.env.LOB_API_KEY;
  if (!key) return { error: 'LOB_API_KEY not set' };
  const siteUrl = await publishForMail(lead);
  const card = { ...lead, siteUrl };
  const frm = {
    name: process.env.KS_FROM_NAME, line1: process.env.KS_FROM_LINE1,
    city: process.env.KS_FROM_CITY, state: process.env.KS_FROM_STATE, zip: process.env.KS_FROM_ZIP,
  };
  if (!frm.name || !frm.line1 || !frm.zip) return { error: 'return address (KS_FROM_*) not set in Vercel' };
  const form = new URLSearchParams({
    description: `KS free-site postcard: ${lead.name}`,
    use_type: 'marketing',
    'to[name]': String(lead.name || '').slice(0, 40),
    'to[address_line1]': lead.street || '', 'to[address_city]': lead.city || '',
    'to[address_state]': lead.state || '', 'to[address_zip]': lead.zip || '',
    'from[name]': frm.name, 'from[address_line1]': frm.line1,
    'from[address_city]': frm.city, 'from[address_state]': frm.state, 'from[address_zip]': frm.zip,
    front: frontHtml(card), back: backHtml(card), size: '6x9',
  });
  const auth = Buffer.from(key + ':').toString('base64');
  const r = await fetch('https://api.lob.com/v1/postcards', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.id) return { id: j.id };
  return { error: (j.error && j.error.message) || ('HTTP ' + r.status), code: j.error && j.error.code };
}

// Run one autopilot batch. Returns a summary; safe to call anytime — it self-gates.
export async function runAutopilot(reason = 'cron') {
  const cfg = await getConfig();
  const stamp = new Date().toISOString();
  const today = stamp.slice(0, 10);

  if (!cfg.enabled) return { ran: false, reason: 'autopilot off' };

  // roll the daily counter over at midnight UTC
  if (cfg.dayStamp !== today) { cfg.mailedToday = 0; cfg.dayStamp = today; }

  const leads = await getLeads();
  const mailedCount = leads.filter(isMailed).length;
  const spent = spentToDate(leads);
  const budgetLeft = (cfg.budgetCeiling || 0) - spent;

  if (budgetLeft <= 0) {
    cfg.enabled = false; // trip the killswitch so it can't overrun
    const note = `budget ceiling reached ($${spent.toFixed(2)} spent of a $${(cfg.budgetCeiling || 0).toFixed(2)} ceiling), autopilot switched OFF`;
    cfg.lastRun = { when: stamp, mailed: 0, note, reason, spent, ceiling: cfg.budgetCeiling || 0 };
    await saveConfig(cfg);
    // This used to happen in total silence: mail just stopped and nobody knew.
    await notifyOperator({
      subject: 'Mailing autopilot switched itself OFF',
      heading: 'Autopilot hit its budget ceiling and stopped',
      lines: [
        `Spent to date: $${spent.toFixed(2)}`,
        `Ceiling was set to: $${(cfg.budgetCeiling || 0).toFixed(2)}`,
        'The ceiling counts TOTAL postage for all time, not new spend, so it is now used up.',
        `To send more, raise the ceiling to at least $${(spent + COST).toFixed(2)} in /admin, then switch autopilot back on.`,
        'No postcards are going out until you do.',
      ],
      url: 'https://killswitchwebsites.com/admin', urlText: 'Open Admin',
    });
    return { ran: false, reason: note, disabled: true, spent, ceiling: cfg.budgetCeiling || 0 };
  }

  const dailyLeft = Math.max(0, (cfg.dailyCap || 0) - (cfg.mailedToday || 0));
  const byBudget = Math.floor(budgetLeft / COST);
  const target = Math.min(dailyLeft, byBudget, PER_RUN);

  let sent = 0, bad = 0, attempts = 0; const failed = [];
  // Read the per-lead notes once, for siteSlug. Not merged into `leads` because
  // that array is written back below and meta lives in its own hash.
  const meta = target > 0 ? await getLeadMeta() : {};
  if (target > 0) {
    for (const l of leads) {
      if (sent >= target || attempts >= ATTEMPT_CAP) break;
      if (!inQueue(l)) continue;
      attempts++;
      const r = await lobSend({ ...l, ...(meta[l.id] || {}) });
      if (r.id) { l.status = 'mailed'; l.lob_id = r.id; sent++; }
      else if (r.code === 'failed_deliverability_strictness') { l.status = 'bad_address'; bad++; }
      else { failed.push({ name: l.name, error: r.error }); if (failed.length >= 5) break; }
    }
  }

  cfg.mailedToday = (cfg.mailedToday || 0) + sent;
  cfg.lastRun = {
    when: stamp, reason, mailed: sent, bad,
    spentAfter: +((mailedCount + sent) * COST).toFixed(2),
    budgetLeft: +(budgetLeft - sent * COST).toFixed(2),
    failed: failed.length,
  };
  if (sent || bad) await saveLeads(leads);
  await saveConfig(cfg);
  return { ran: true, ...cfg.lastRun, dailyLeftBefore: dailyLeft, queueTouched: attempts };
}
