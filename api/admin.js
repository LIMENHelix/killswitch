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
//   config  -> autopilot settings, read only                      (both roles)
//   update / suppress -> record an outcome or do-not-contact      (both roles)
//   setconfig / run-autopilot / mail / seed / unsuppress          (owner only)
//
// Nothing mails unless the OWNER posts action:mail with explicit ids.

import { configured, getLeads, saveLeads, getConfig, saveConfig, getLeadMeta, setLeadMeta } from '../lib/store.js';
import { lobSend, runAutopilot, spentToDate, COST } from '../lib/mailer.js';
import { identify, isOwner, anyKeyConfigured } from '../lib/roles.js';
import { getSite, upsertSite } from '../lib/sites.js';
import { getFunnel, setStage, summarize, toPlays, migrateFrom, migrateStage, STAGES } from '../lib/funnel.js';
import { wilsonLower, allocate } from '../lib/laser.js';
import { getSuppressionState, matchSuppression, suppressContact, liftSuppression, listSuppressions } from '../lib/suppression.js';

const OWNER_ONLY = new Set(['setconfig', 'run-autopilot', 'mail', 'seed', 'unsuppress', 'suppression-list']);

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
    // a number the page can already derive from the leads it just fetched. The
    // authoritative spend check lives in setconfig, which runs only on a click.
    if (action === 'config') {
      res.status(200).json({ ok: true, config: await getConfig(), role: who.role }); return;
    }
    if (action === 'setconfig') {
      const cur = await getConfig();
      const next = { ...cur };
      if (body.enabled !== undefined) next.enabled = !!body.enabled;
      if (body.dailyCap !== undefined) next.dailyCap = Math.max(0, Math.floor(Number(body.dailyCap) || 0));
      if (body.budgetCeiling !== undefined) next.budgetCeiling = Math.max(0, Number(body.budgetCeiling) || 0);

      // The ceiling counts postage already spent. Arming with a ceiling at or
      // below that would switch autopilot on and then trip it dead on the first
      // run, hours later, looking like a silent failure. Refuse it now instead.
      const spent = spentToDate(await getLeads());
      const minCeiling = +(spent + COST).toFixed(2); // room for at least one postcard
      if (next.enabled && next.budgetCeiling < minCeiling) {
        res.status(400).json({
          error: 'budget_below_spend',
          spent, minCeiling,
          message: `You have already spent $${spent.toFixed(2)} on postage. The ceiling is TOTAL spend, not new spend, so a $${next.budgetCeiling.toFixed(2)} ceiling leaves nothing to mail with. Set it to at least $${minCeiling.toFixed(2)} before switching autopilot on.`,
        });
        return;
      }

      await saveConfig(next);
      res.status(200).json({ ok: true, config: next, spent }); return;
    }
    if (action === 'run-autopilot') {
      res.status(200).json({ ok: true, result: await runAutopilot('manual') }); return;
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
      const ids = new Set(body.ids || []);
      const cap = Math.min(ids.size, 250); // safety ceiling per call
      const leads = await getLeads();
      // Read the per-lead notes separately rather than merging them into `leads`:
      // this array gets written back below, and meta belongs in its own hash.
      const [meta, suppressionState] = await Promise.all([getLeadMeta(), getSuppressionState()]);
      let sent = 0, bad = 0, suppressed = 0; const failed = [];
      let done = 0;
      for (const l of leads) {
        if (done >= cap) break;
        if (!ids.has(l.id) || l.status === 'mailed' || l.status === 'bad_address' || l.lob_id) continue;
        done++;
        const r = await lobSend({ ...l, ...(meta[l.id] || {}) }, suppressionState);
        if (r.id) { l.status = 'mailed'; l.lob_id = r.id; sent++; }
        else if (r.code === 'failed_deliverability_strictness') { l.status = 'bad_address'; bad++; }
        else if (r.code === 'suppressed') { suppressed++; }
        else { failed.push({ name: l.name, error: r.error }); }
      }
      await saveLeads(leads);
      res.status(200).json({ ok: true, sent, bad, suppressed, failed }); return;
    }
    res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error('[admin]', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
