// Scheduled K6 prospect-outreach run. Vercel cron hits this on a schedule (see
// vercel.json). It self-gates: with the K6 outreach config not armed this does
// exactly nothing — no provider call, no spend.
//
// AUTH: CRON_SECRET Bearer only. No query/body token fallback. The cron URL
// spends real money (Lob postage) and must never be reachable without the
// project secret. Owner manual triggers use the owner-authenticated
// /api/admin actions (run-outreach / run-autopilot / mail).
import { runPostcardOutreach } from '../lib/k6-outreach.js';
import { cronAuthorized } from '../lib/cron-auth.js';

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (!cronAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const result = await runPostcardOutreach({ clock: () => new Date() });
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('[cron-mail]', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
