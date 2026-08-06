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
//   update  -> {id, stage?, notes?} record a call outcome         (both roles)
//   setconfig / run-autopilot / mail / seed                       (owner only)
//
// Nothing mails unless the OWNER posts action:mail with explicit ids.

import { configured, getLeads, saveLeads, getConfig, saveConfig, getLeadMeta, setLeadMeta } from '../lib/store.js';
import { lobSend, runAutopilot, spentToDate, COST } from '../lib/mailer.js';
import { identify, isOwner, anyKeyConfigured } from '../lib/roles.js';

const OWNER_ONLY = new Set(['setconfig', 'run-autopilot', 'mail', 'seed']);

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
    if (action === 'list') {
      const [leads, meta] = await Promise.all([getLeads(), getLeadMeta()]);
      // Per-lead notes live in their own hash now. Fall back to whatever is still
      // on the lead itself so nothing written before this change disappears.
      const merged = leads.map((l) => {
        const m = meta[l.id];
        return m ? { ...l, ...m } : l;
      });
      res.status(200).json({ ok: true, leads: merged, role: who.role, name: who.name }); return;
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
      // Writes one hash field, not the whole 600 KB lead list, so two people
      // working different leads cannot overwrite each other any more.
      const patch = {};
      if (body.stage !== undefined) patch.stage = body.stage;
      if (body.notes !== undefined) patch.notes = body.notes;
      // Whoever moves a lead owns it. This is what makes commission a number
      // instead of an argument. First toucher keeps it unless the owner reassigns.
      if (body.stage !== undefined) {
        const existing = (await getLeadMeta())[body.id];
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
    if (action === 'mail') {
      const ids = new Set(body.ids || []);
      const cap = Math.min(ids.size, 250); // safety ceiling per call
      const leads = await getLeads();
      let sent = 0, bad = 0; const failed = [];
      let done = 0;
      for (const l of leads) {
        if (done >= cap) break;
        if (!ids.has(l.id) || l.status === 'mailed' || l.status === 'bad_address' || l.lob_id) continue;
        done++;
        const r = await lobSend(l);
        if (r.id) { l.status = 'mailed'; l.lob_id = r.id; sent++; }
        else if (r.code === 'failed_deliverability_strictness') { l.status = 'bad_address'; bad++; }
        else { failed.push({ name: l.name, error: r.error }); }
      }
      await saveLeads(leads);
      res.status(200).json({ ok: true, sent, bad, failed }); return;
    }
    res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error('[admin]', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
