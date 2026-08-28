// Rep actions: read/note/claim leads from the board.
//
// POST /api/rep-action   body: { token, email, action, ... }
//   action = 'claim' { email } -> claim a lead as owner
//   action = 'note' { email, note } -> add a note to a lead
//   action = 'status' { email, status } -> move lead to new status
//
// Reps can only modify leads they own (except claim, which takes ownership).

import { getLeads, getLeadMeta, saveLeadMeta } from '../lib/store.js';
import { identify, REP } from '../lib/roles.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  const token = String(body.token || '');
  const who = identify(token);

  if (!who || who.role !== REP) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const action = String(body.action || '').toLowerCase();
  const email = String(body.email || '').trim().toLowerCase();

  if (!email) {
    res.status(400).json({ error: 'email_required' });
    return;
  }

  try {
    const meta = await getLeadMeta();
    const leadMeta = meta[email] || { owner: null, notes: [], status: 'new' };

    if (action === 'claim') {
      // Claim a lead: take ownership. First rep to claim it owns it.
      // If already claimed by someone else, allow takeover (simpler than disputes).
      leadMeta.owner = who.name;
      leadMeta.claimedAt = new Date().toISOString();
      await saveLeadMeta({ [email]: leadMeta });
      res.status(200).json({ ok: true, action: 'claim', email, owner: who.name });
      return;
    }

    // All other actions require ownership
    if (leadMeta.owner !== who.name) {
      res.status(403).json({ error: 'not_owner' });
      return;
    }

    if (action === 'note') {
      const note = String(body.note || '').trim();
      if (!note) {
        res.status(400).json({ error: 'note_required' });
        return;
      }
      if (!leadMeta.notes) leadMeta.notes = [];
      leadMeta.notes.push({
        at: new Date().toISOString(),
        by: who.name,
        text: note,
      });
      await saveLeadMeta({ [email]: leadMeta });
      res.status(200).json({ ok: true, action: 'note' });
      return;
    }

    if (action === 'status') {
      const status = String(body.status || '').trim();
      const validStatuses = ['new', 'called', 'qualified', 'quoted', 'won', 'lost'];
      if (!validStatuses.includes(status)) {
        res.status(400).json({ error: 'invalid_status' });
        return;
      }
      leadMeta.status = status;
      leadMeta.statusAt = new Date().toISOString();
      await saveLeadMeta({ [email]: leadMeta });
      res.status(200).json({ ok: true, action: 'status', status });
      return;
    }

    res.status(400).json({ error: 'unknown_action' });
  } catch (e) {
    console.error('[rep-action]', e);
    res.status(500).json({ error: 'server_error' });
  }
}
