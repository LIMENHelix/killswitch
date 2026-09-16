// Killswitch Websites admin API. TWO roles, see lib/roles.js.
//
//   owner (ADMIN_KEY / SWITCH_TOKEN) -- everything
//   rep   (REP_KEYS "name:key,...")  -- read the board, record what happened
//
// A rep can work the call list and log the outcome. A rep CANNOT spend postage,
// arm the autopilot, reseed the list, or reach /master, /api/signup or the
// customer portal links. Before this there was one key for all of it, so the
// credential a commissioned caller needs was also the credential that spends
// money and opens every customer's billing.
//
// Actions (POST {action, token, ...}):
//   list    -> all leads, merged with per-lead stage/notes/owner  (both roles)
//   config  -> legacy autopilot blob, read only, HISTORICAL       (both roles)
//   update / suppress -> record an outcome or do-not-contact      (both roles)
//   setconfig -> RETIRED, always 409 (see below)                  (owner only)
//   run-autopilot / mail / seed / unsuppress                      (owner only)
//   outreach-status / outreach-runs / outreach-effects            (owner only)
//   outreach-setconfig / run-outreach / run-scorecard             (owner only)
//   run-followups / run-maintenance                               (owner only)
//
// THE CONTROL PLANE IS K6. The legacy ks:autopilot config (setconfig's switch,
// daily cap and budget ceiling) has no sender: cron-mail, run-autopilot and
// mail all execute through the armed K6 outreach plane, so setconfig refuses
// rather than store values nothing reads. The blob itself is kept and served
// read-only via action:config — the historical mailed/spend counters live on
// the lead ledger and are unaffected.
//
// Nothing mails unless the OWNER posts action:mail with explicit ids, and even
// then only through the armed K6 outreach control plane.

import { configured, getLeads, saveLeads, getConfig, getLeadMeta, setLeadMeta } from '../lib/store.js';
import { identify, isOwner, anyKeyConfigured } from '../lib/roles.js';
import { getSite, upsertSite } from '../lib/sites.js';
import { getFunnel, setStage, summarize, toPlays, migrateFrom, migrateStage, STAGES } from '../lib/funnel.js';
import { wilsonLower, allocate } from '../lib/laser.js';
import { getSuppressionState, matchSuppression, suppressContact, liftSuppression, listSuppressions } from '../lib/suppression.js';
import { discStatus, listRankedCandidates, listRuns, listCalls, getDiscConfig, saveDiscConfig, validateDiscConfigPatch, resetDiscCursor } from '../lib/discovery.js';
import { draftAutonomyStatus, listDraftRuns, getDraftConfig, saveDraftConfig, validateDraftConfigPatch } from '../lib/draft-autonomy.js';
import { runPostcardOutreach, getOutreachConfig, saveOutreachConfig, outreachConfigArmable, validateOutreachConfigPatch, outreachReadiness } from '../lib/k6-outreach.js';
import { listRuns as listOutreachRuns, listEffects, getStatusCounts } from '../lib/outreach-effects.js';
import { collectWeeklyScorecard, previousCompleteWeek } from '../lib/scorecard.js';
import { notifyOperator } from '../lib/notify.js';
import { publicOrigin } from '../lib/origin.js';
import { cmd, pipeline } from '../lib/kv.js';
import { drainFollowups } from './cron-followups.js';
import { followupStatus } from '../lib/automation.js';
import { runMaintenance } from './cron-maintenance.js';

const OWNER_ONLY = new Set(['setconfig', 'run-autopilot', 'mail', 'seed', 'unsuppress', 'suppression-list', 'disc-setconfig', 'draft-setconfig', 'outreach-status', 'outreach-setconfig', 'outreach-runs', 'outreach-effects', 'outreach-readiness', 'run-outreach', 'run-scorecard', 'run-followups', 'followup-status', 'run-maintenance']);

function outreachStatus(cfg) {
  const armable = outreachConfigArmable(cfg);
  const blockers = [];
  if (!armable) {
    if (!cfg.enabled) blockers.push('disabled');
    if (!(Number(cfg.perRunCap) > 0)) blockers.push('perRunCap must be > 0');
    if (!(Number(cfg.dailyCap) > 0)) blockers.push('dailyCap must be > 0');
    if (!(Number(cfg.lifetimeCap) > 0)) blockers.push('lifetimeCap must be > 0');
    if (!(Number(cfg.perRunSpendCap) > 0)) blockers.push('perRunSpendCap must be > 0');
    if (!(Number(cfg.dailySpendCap) > 0)) blockers.push('dailySpendCap must be > 0');
    if (!(Number(cfg.postcardReserveCents) > 0)) blockers.push('postcardReserveCents must be > 0 (owner-set budget reserve per card, cents)');
    if (!Array.isArray(cfg.channels) || cfg.channels.length === 0) blockers.push('at least one supported channel required (postcard)');
    else if (!cfg.channels.every((c) => ['postcard'].includes(c))) blockers.push('unsupported channel (this build supports: postcard)');
    if (!['autonomous', 'manual', 'test'].includes(cfg.mode)) blockers.push('mode must be autonomous, manual, or test');
  }
  return { armed: armable, blockers };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }
  if (!anyKeyConfigured()) { res.status(503).json({ error: 'no_auth_configured' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const who = identify(body.token || req.headers['x-admin-key']);
  if (!who) { res.status(401).json({ error: 'unauthorized' }); return; }
  if (!configured()) { res.status(503).json({ error: 'no_store', message: 'Add an Upstash KV store to this Vercel project.' }); return; }

  const action = body.action;
  if (OWNER_ONLY.has(action) && !isOwner(who)) {
    res.status(403).json({
      error: 'forbidden',
      message: 'That is an owner action. Your sign-in can work the call list and log outcomes, but not spend postage or change the mailing settings.',
    });
    return;
  }

  try {
    // The funnel board: stage counts, per-transition conversion, and the plays
    // laser.js ranks. Read-only, so a rep can see what is working.
    if (action === 'funnel') {
      const f = await getFunnel();
      const sum = summarize(f);
      const plays = toPlays(f);
      const ranked = plays
        .map((p) => ({ ...p, score: wilsonLower(p.wins, p.trials) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);
      // Volume the optimizer would hand each play next. Winners get fed, losers
      // keep an exploration floor rather than being starved of data.
      let weights = {};
      try { weights = allocate(plays); } catch (e) { console.error('[admin] allocate', e); }
      res.status(200).json({ ok: true, ...sum, ranked, weights, role: who.role });
      return;
    }

    if (action === 'migrate-funnel') {
      res.status(200).json({ ok: true, ...(await migrateFrom(await getLeadMeta())) });
      return;
    }

    if (action === 'list') {
      const [leads, meta, suppressionState] = await Promise.all([getLeads(), getLeadMeta(), getSuppressionState()]);
      // Per-lead notes live in their own hash now. Fall back to whatever is still
      // on the lead itself so nothing written before this change disappears.
      const funnel = await getFunnel();
      const merged = leads.map((l) => {
        const m = meta[l.id];
        const f = funnel[l.id];
        const base = m ? { ...l, ...m } : l;
        // The funnel record is authoritative for stage; the old flat value is
        // migrated on read so nothing looks blank before migrate-funnel is run.
        const suppression = matchSuppression(base, suppressionState);
        return { ...base, stage: f ? f.stage : migrateStage(base.stage), dealCents: f ? f.dealCents : 0,
          touches: f ? f.touches.length : 0, apptAt: f ? f.apptAt : '',
          suppressed: !!suppression, suppressionId: suppression?.id || '',
          suppressionReason: suppression?.reason || '', suppressionAt: suppression?.suppressedAt || '' };
      });
      const suppressionCount = Object.entries(suppressionState)
        .filter(([field, rec]) => field.startsWith('r:') && rec && rec.active !== false).length;
      res.status(200).json({ ok: true, leads: merged, suppressionCount, role: who.role, name: who.name }); return;
    }
    if (action === 'suppression-list') {
      res.status(200).json({ ok: true, suppressions: await listSuppressions() }); return;
    }
    if (action === 'suppress') {
      const [leads, meta] = await Promise.all([getLeads(), getLeadMeta()]);
      const lead = leads.find((l) => String(l.id) === String(body.id));
      if (!lead) { res.status(404).json({ error: 'lead_not_found' }); return; }
      const rec = await suppressContact({ ...lead, ...(meta[lead.id] || {}) }, {
        reason: body.reason, actor: who.name, source: body.channel || 'manual',
      });
      await setLeadMeta(lead.id, {
        suppressed: true, suppressionId: rec.id, suppressionReason: rec.reason, suppressionAt: rec.suppressedAt,
      });
      try { await setStage(lead.id, 'dead', { channel: body.channel || 'call', note: rec.reason }); }
      catch (e) { console.error('[admin] suppress funnel', e); }
      res.status(200).json({ ok: true, suppression: rec }); return;
    }
    if (action === 'unsuppress') {
      let suppressionId = String(body.suppressionId || '');
      let lead = null;
      if (!suppressionId && body.id) {
        const [leads, meta, state] = await Promise.all([getLeads(), getLeadMeta(), getSuppressionState()]);
        lead = leads.find((l) => String(l.id) === String(body.id));
        const rec = lead && matchSuppression({ ...lead, ...(meta[lead.id] || {}) }, state);
        suppressionId = rec?.id || '';
      }
      const lifted = await liftSuppression(suppressionId, who.name);
      if (!lifted) { res.status(404).json({ error: 'suppression_not_found' }); return; }
      if (body.id) await setLeadMeta(body.id, { suppressed: false, suppressionId: '', suppressionReason: '' });
      res.status(200).json({ ok: true, ...lifted }); return;
    }
    // Deliberately does NOT read the lead list. /admin polls this every minute and
    // the leads blob is ~600 KB, so reading it here would double Upstash egress for
    // a number the page can already derive from the leads it just fetched.
    // HISTORICAL: the legacy ks:autopilot blob drives no sender (K6 is the only
    // mail path); it is served read-only so the admin page can show the old
    // values as a historical record. Viewing never mutates it.
    if (action === 'config') {
      res.status(200).json({ ok: true, config: await getConfig(), supersededBy: 'k6-outreach', role: who.role }); return;
    }
    if (action === 'setconfig') {
      // RETIRED. The legacy autopilot's switch/caps have no consumer — every
      // send runs through the armed K6 control plane — so storing new values
      // here would paint a switch that does nothing. Refuse, mutate nothing,
      // and point at the real control. The stored blob stays untouched as the
      // historical record served by action:config.
      res.status(409).json({
        error: 'legacy_autopilot_superseded',
        supersededBy: 'k6-outreach',
        message: 'The old mailing autopilot no longer sends anything and cannot be switched on. Postcard sends are armed, capped and budgeted in the K6 outreach panel (outreach-setconfig).',
      });
      return;
    }
    if (action === 'run-autopilot') {
      // The legacy name for "run the prospect mail batch now". It goes through
      // the same K6 control plane as everything else: unarmed means no send.
      const result = await runPostcardOutreach({});
      if (!result.ran) {
        res.status(409).json({ error: 'outreach_not_armed', reason: result.reason, message: 'K6 outreach is not armed. Prospect postcard sends stay off until the owner stores a complete outreach config.' });
        return;
      }
      res.status(200).json({ ok: true, result }); return;
    }
    if (action === 'run-followups') {
      const r = await drainFollowups();
      res.status(r.code).json(r.body); return;
    }
    if (action === 'followup-status') {
      // Queue depth, terminal ledger sizes, recent dead letters with reasons,
      // and the last drain summary. Owner-only: dead letters carry recipient
      // contact handles.
      res.status(200).json({ ok: true, ...(await followupStatus()) }); return;
    }
    if (action === 'run-maintenance') {
      const r = await runMaintenance();
      res.status(r.code).json(r.body); return;
    }
    // K4 discovery — read-only views for both roles; only the owner can touch
    // the config. These endpoints expose candidate facts and run ledgers, never
    // credentials: the Places key never leaves the server, and config caps/plan
    // are operator-supplied values, not secrets.
    if (action === 'disc-status') {
      res.status(200).json({ ok: true, ...(await discStatus()), role: who.role }); return;
    }
    if (action === 'disc-candidates') {
      res.status(200).json({ ok: true, candidates: await listRankedCandidates(body.limit) }); return;
    }
    if (action === 'disc-runs') {
      res.status(200).json({ ok: true, runs: await listRuns(body.limit) }); return;
    }
    if (action === 'disc-calls') {
      // Call-level money audit: reservation outcomes per logical paid call.
      res.status(200).json({ ok: true, calls: await listCalls(body.limit) }); return;
    }
    if (action === 'disc-setconfig') {
      const checked = validateDiscConfigPatch(await getDiscConfig(), body);
      if (checked.error) { res.status(400).json({ error: checked.error, message: checked.message }); return; }
      await saveDiscConfig(checked.config);
      if (body.resetCursor) await resetDiscCursor();
      res.status(200).json({ ok: true, config: checked.config, cursorReset: !!body.resetCursor }); return;
    }
    // K5 draft autonomy — read-only views for both roles; only owner can arm.
    if (action === 'draft-status') {
      res.status(200).json({ ok: true, ...(await draftAutonomyStatus()), role: who.role }); return;
    }
    if (action === 'draft-runs') {
      res.status(200).json({ ok: true, runs: await listDraftRuns(body.limit) }); return;
    }
    if (action === 'draft-setconfig') {
      const checked = validateDraftConfigPatch(await getDraftConfig(), body);
      if (checked.error) { res.status(400).json({ error: checked.error, message: checked.message }); return; }
      await saveDraftConfig(checked.config);
      res.status(200).json({ ok: true, config: checked.config }); return;
    }
    // K6 outreach — owner-only config and manual trigger; read-only status/runs/effects for both roles.
    if (action === 'outreach-status') {
      const cfg = await getOutreachConfig();
      const { armed, blockers } = outreachStatus(cfg);
      res.status(200).json({
        ok: true,
        armed,
        config: {
          enabled: cfg.enabled,
          mode: cfg.mode,
          channels: cfg.channels,
          perRunCap: cfg.perRunCap,
          dailyCap: cfg.dailyCap,
          lifetimeCap: cfg.lifetimeCap,
          perRunSpendCap: cfg.perRunSpendCap,
          dailySpendCap: cfg.dailySpendCap,
          postcardReserveCents: cfg.postcardReserveCents,
        },
        counts: await getStatusCounts(),
        runs: await listOutreachRuns(5),
        blockers,
        role: who.role,
      }); return;
    }
    if (action === 'outreach-setconfig') {
      const checked = validateOutreachConfigPatch(await getOutreachConfig(), body);
      if (checked.error) { res.status(400).json({ error: checked.error, message: checked.message }); return; }
      await saveOutreachConfig(checked.config);
      res.status(200).json({ ok: true, config: checked.config }); return;
    }
    if (action === 'outreach-runs') {
      res.status(200).json({ ok: true, runs: await listOutreachRuns(body.limit || 10) }); return;
    }
    if (action === 'outreach-effects') {
      res.status(200).json({ ok: true, effects: await listEffects(body.limit || 50) }); return;
    }
    if (action === 'outreach-readiness') {
      // Aggregate-only canary readiness: counts, provider mode, reserve config.
      // No prospect PII, no secrets — the shape is enforced inside
      // outreachReadiness(), which returns nothing but aggregates and booleans.
      res.status(200).json({ ok: true, readiness: await outreachReadiness() }); return;
    }
    if (action === 'run-outreach') {
      const result = await runPostcardOutreach({});
      if (!result.ran) {
        res.status(409).json({ error: 'outreach_not_armed', reason: result.reason, message: 'K6 outreach is not armed. Store a complete outreach config first.' });
        return;
      }
      res.status(200).json({ ok: true, ...result }); return;
    }
    if (action === 'run-scorecard') {
      const period = previousCompleteWeek(new Date());
      const sentKey = `ks:scorecard:sent:${period.endDate}`;
      const claimKey = `ks:scorecard:claim:${period.endDate}`;
      if (await cmd(['GET', sentKey])) {
        res.status(200).json({ ok: true, sent: false, duplicate: true, period });
        return;
      }
      const claimed = await cmd(['SET', claimKey, new Date().toISOString(), 'NX', 'EX', '900']);
      if (claimed !== 'OK') { res.status(200).json({ ok: true, sent: false, busy: true, period }); return; }
      try {
        const report = await collectWeeklyScorecard(new Date());
        const a = report.acquisition, activity = report.activity, economics = report.economics, operations = report.operations;
        const notify = await notifyOperator({
          subject: `Weekly Killswitch scorecard - ${report.period.startDate} to ${report.period.endDate}`,
          heading: 'Your weekly operating scorecard is ready',
          lines: [
            `Period: ${report.period.startDate} through ${report.period.endDate} (end exclusive)`,
            `Valid signups: ${a.validSignups} | claimed sites: ${a.claimedSites} | paid activations: ${a.paidActivations}`,
            `Signup to claimed: ${a.signupToClaimedRate == null ? 'n/a' : a.signupToClaimedRate + '%'} | claimed to paid: ${a.claimedToPaidRate == null ? 'n/a' : a.claimedToPaidRate + '%'}`,
            `Calls: ${activity.calls} | bookings: ${activity.bookings} | enquiries: ${activity.enquiries} | suppression requests: ${activity.suppressionRequests}`,
            `Tracked spend: $${(economics.trackedSpendCents / 100).toFixed(2)} | collected: $${(economics.collectedCents / 100).toFixed(2)} | refunded: $${(economics.refundedCents / 100).toFixed(2)}`,
            `Payment failures: ${operations.paymentFailures} | disputes: ${operations.disputes} | failed webhooks: ${operations.failedWebhooks}`,
            `Open work orders: ${operations.openWorkOrders} | blocked customers: ${operations.blockedCustomers} | dead letters: ${operations.deadLetters}`,
            'Search Console and Vercel Web Analytics remain external dashboard inputs and are not guessed in this email.',
            'Google Ads remains disabled until a budget and stop-loss are approved.',
          ],
          url: publicOrigin() + '/master',
          urlText: 'Open the full scorecard',
        });
        if (!notify.sent) {
          await cmd(['DEL', claimKey]);
          res.status(500).json({ error: 'notify_failed', reason: notify.reason });
          return;
        }
        const expirySeconds = 400 * 86400;
        const nowIso = new Date().toISOString();
        await pipeline([
          ['SET', sentKey, nowIso, 'EX', String(expirySeconds)],
          ['SET', 'ks:scorecard:last', JSON.stringify({ sentAt: nowIso, endDate: period.endDate, report })],
          ['DEL', claimKey],
        ]);
        res.status(200).json({ ok: true, sent: true, report });
      } catch (e) {
        await cmd(['DEL', claimKey]).catch(() => {});
        console.error('[admin] run-scorecard', e);
        res.status(500).json({ error: String(e.message || e) });
      }
      return;
    }
    if (action === 'seed') {
      const leads = Array.isArray(body.leads) ? body.leads : [];
      await saveLeads(leads);
      res.status(200).json({ ok: true, count: leads.length }); return;
    }
    if (action === 'update') {
      let existingMeta = null;
      if (body.stage !== undefined && body.stage !== 'dead') {
        const [leads, meta, state] = await Promise.all([getLeads(), getLeadMeta(), getSuppressionState()]);
        existingMeta = meta[body.id];
        const lead = leads.find((l) => String(l.id) === String(body.id));
        if (lead && matchSuppression({ ...lead, ...(existingMeta || {}) }, state)) {
          res.status(409).json({ error: 'contact_suppressed', message: 'Lift the do-not-contact suppression before reopening this lead.' });
          return;
        }
      }
      // A stage change is a funnel event, not just a label. Recording it through
      // setStage writes the transition and channel the optimizer learns from;
      // writing the word alone would leave laser.js with nothing to rank.
      if (body.stage !== undefined && STAGES.includes(body.stage)) {
        try {
          await setStage(body.id, body.stage, {
            channel: body.channel || 'call',
            dealCents: Number.isFinite(body.dealCents) ? body.dealCents : undefined,
            apptAt: body.apptAt,
            note: body.notes,
          });
        } catch (e) { console.error('[admin] setStage', e); }
      }

      // Writes one hash field, not the whole 600 KB lead list, so two people
      // working different leads cannot overwrite each other any more.
      const patch = {};
      if (body.stage !== undefined) patch.stage = body.stage;
      if (body.notes !== undefined) patch.notes = body.notes;
      // Whoever moves a lead owns it. This is what makes commission a number
      // instead of an argument. First toucher keeps it unless the owner reassigns.
      if (body.stage !== undefined) {
        const existing = existingMeta || (await getLeadMeta())[body.id];
        if (!existing || !existing.owner) patch.owner = who.name;
      }
      if (isOwner(who) && body.owner !== undefined) patch.owner = body.owner;

      const saved = await setLeadMeta(body.id, patch);

      // Mail state still belongs to the lead record itself, and only the owner
      // can change it.
      if (isOwner(who) && body.status !== undefined) {
        const leads = await getLeads();
        const l = leads.find((x) => x.id === body.id);
        if (l) { l.status = body.status; await saveLeads(leads); }
      }
      res.status(200).json({ ok: true, meta: saved }); return;
    }
    // THE DELIVERY MOMENT, and the one write a rep is trusted with.
    // The shop said "yes, text me the link", so their draft goes live. It is
    // published but NOT claimed, so the link works and search engines still stay
    // out until they actually become a customer (owner-only, via onboarding).
    // A rep cannot edit content, cannot unpublish, and cannot make it indexable.
    if (action === 'site-publish') {
      const [leads, meta, state] = await Promise.all([getLeads(), getLeadMeta(), getSuppressionState()]);
      const directLead = leads.find((l) => String(l.id) === String(body.id));
      if (directLead && matchSuppression({ ...directLead, ...(meta[directLead.id] || {}) }, state)) {
        res.status(409).json({ error: 'contact_suppressed', message: 'This contact is on the do-not-contact list.' }); return;
      }
      const slug = body.slug || (meta[body.id] && meta[body.id].siteSlug);
      if (!slug) { res.status(404).json({ error: 'no_site', message: 'No website has been drafted for this lead yet.' }); return; }
      const site = await getSite(slug);
      if (!site) { res.status(404).json({ error: 'no_site' }); return; }
      const lead = directLead || leads.find((l) => String(l.id) === String(site.leadId));
      if (lead && matchSuppression({ ...lead, ...(meta[lead.id] || {}) }, state)) {
        res.status(409).json({ error: 'contact_suppressed', message: 'This contact is on the do-not-contact list.' }); return;
      }
      if (!site.published) await upsertSite({ slug, published: true });
      if (body.id) await setLeadMeta(body.id, { siteSlug: slug, sitePublished: true, publishedBy: who.name });
      res.status(200).json({ ok: true, slug, url: '/s/' + slug, alreadyLive: !!site.published });
      return;
    }

    if (action === 'mail') {
      // Owner-approved prospect postcards. This is the same K6 money path as
      // the cron: eligibility, suppression, durable effect reservation, caps,
      // provider idempotency. When K6 outreach is not armed it fails CLOSED —
      // owner authority initiates the bounded workflow, it does not bypass it.
      // The 250-id ceiling is a request-size bound on top of the configured
      // caps, never a replacement for them.
      const ids = new Set((Array.isArray(body.ids) ? body.ids : []).slice(0, 250));
      if (!ids.size) { res.status(400).json({ error: 'no_ids' }); return; }
      const result = await runPostcardOutreach({ idFilter: ids, requestCeiling: 250 });
      if (!result.ran) {
        res.status(409).json({ error: 'outreach_not_armed', reason: result.reason, message: 'K6 outreach is not armed. Prospect postcard sends stay off until the owner stores a complete outreach config.' });
        return;
      }
      res.status(200).json({ ok: true, k6: true, ...result }); return;
    }
    res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error('[admin]', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
