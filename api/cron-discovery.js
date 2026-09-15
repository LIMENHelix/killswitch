// K4 discovery cron — the first UPSTREAM autonomous loop: bounded Google Places
// discovery → canonical identity → cross-run dedupe → exclusion → durable
// candidate state → deterministic ranking → STOP.
//
// HARD BOUNDARIES, by construction of what this file imports:
//   - no mailer, no Lob, no Resend outreach, no voice agent, no SMS
//   - no draftFromLead / site-bulk-draft / site publication
//   - no Stripe
// A candidate reaching "ranked" is the end of the line. Contacting anyone from
// this path would require new code, not a configuration flip.
//
// MONEY: Places calls cost money. This handler spends NOTHING unless the
// discovery config (ks:disc:cfg) is explicitly enabled AND complete (caps +
// plan), which no deployment or env var can do by itself — arming is an owner
// action through api/admin.js action:disc-setconfig. Deploying this cron in an
// unconfigured environment makes zero Places calls forever.
//
// AUTH: CRON_SECRET Bearer only, fail closed on both sides (a missing secret
// authorizes nobody, including when the caller also presents nothing). No
// query-string tokens here — unlike the older crons, this path has no legacy
// operator URL to preserve.
import { runDiscovery } from '../lib/discovery.js';
import { cronAuthorized } from '../lib/cron-auth.js';

export default async function handler(req, res) {
  if (!cronAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const result = await runDiscovery();
    // 200 even when disabled/lease-held: those are normal states, not errors,
    // and Vercel retries on 5xx would just add noise. A failed run still
    // returns its ledger with status:'failed' and the cursor unmoved, so the
    // next invocation retries the same slot honestly.
    res.status(200).json({ ok: result.reason === 'completed' || result.reason === 'caught_up' || result.reason === 'no_work' || result.reason === 'disabled' || result.reason === 'incomplete_config' || result.reason === 'no_places_key' || result.reason === 'lease_held', ...result });
  } catch (e) {
    console.error('[cron-discovery]', e);
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
