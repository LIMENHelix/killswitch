// KILLSWITCH admin API. Gated by ADMIN_KEY (falls back to SWITCH_TOKEN).
// Actions (POST {action, token, ...}):
//   list   -> all leads
//   seed   -> {leads:[...]} bulk load (one-time, from _outreach/seed_kv.py)
//   update -> {id, status?, notes?} update one lead
//   mail   -> {ids:[...]} send a postcard to each via Lob (server-side, manual approval)
// Nothing mails unless you POST action:mail with explicit ids. Human-in-the-loop.

import { configured, getLeads, saveLeads, getConfig, saveConfig } from '../lib/store.js';
import { lobSend, runAutopilot, spentToDate, COST } from '../lib/mailer.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }
  const KEYS = [process.env.ADMIN_KEY, process.env.SWITCH_TOKEN].filter(Boolean);
  if (!KEYS.length) { res.status(503).json({ error: 'no_auth_configured' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const provided = body.token || req.headers['x-admin-key'];
  if (!KEYS.includes(provided)) { res.status(401).json({ error: 'unauthorized' }); return; }
  if (!configured()) { res.status(503).json({ error: 'no_store', message: 'Add an Upstash KV store to this Vercel project.' }); return; }

  const action = body.action;
  try {
    if (action === 'list') {
      res.status(200).json({ ok: true, leads: await getLeads() }); return;
    }
    if (action === 'config') {
      const spent = spentToDate(await getLeads());
      res.status(200).json({ ok: true, config: await getConfig(), spent }); return;
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
      const leads = await getLeads();
      const l = leads.find((x) => x.id === body.id);
      if (l) {
        if (body.status !== undefined) l.status = body.status;
        if (body.stage !== undefined) l.stage = body.stage;
        if (body.notes !== undefined) l.notes = body.notes;
        await saveLeads(leads);
      }
      res.status(200).json({ ok: true, lead: l || null }); return;
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
