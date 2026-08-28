// Rep-facing lead board. Reps can read their assigned leads.
//
// GET /api/rep-board?token=<REP_KEY>
//   -> { ok, leads: [...], owner: 'name' }
//
// Shows leads assigned to this rep (owner field). Reps can move/note leads
// but cannot arm autopilot, spend postage, or mint accounts.

import { getLeads, getLeadMeta, saveLeadMeta } from '../lib/store.js';
import { identify, isOwner, REP } from '../lib/roles.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const token = String(req.query.token || '');
  const who = identify(token);

  if (!who || who.role !== REP) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const leads = await getLeads();
    const meta = await getLeadMeta();

    // Filter to leads assigned to this rep (by email key in leadmeta.owner)
    const assigned = leads.filter((lead) => {
      const m = meta[lead.email] || {};
      return m.owner === who.name;
    });

    res.status(200).json({
      ok: true,
      owner: who.name,
      leads: assigned.map((l) => ({
        email: l.email,
        name: l.name,
        phone: l.phone,
        trade: l.trade,
        street: l.street,
        city: l.city,
        state: l.state,
        zip: l.zip,
        status: l.status,
        source: l.source,
        createdAt: l.createdAt,
      })),
    });
  } catch (e) {
    console.error('[rep-board]', e);
    res.status(500).json({ error: 'server_error' });
  }
}
