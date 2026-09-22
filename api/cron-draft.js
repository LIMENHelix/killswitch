// K5 autonomous draft cron — ranked K4 candidate → re-derive eligibility →
// one factual UNPUBLISHED site draft → link candidate → STOP.
//
// HARD BOUNDARIES, by construction of what this file imports:
//   - no mailer, no Lob, no Resend outreach, no voice agent, no SMS
//   - no publishForMail / site publication / customer onboarding
//   - no Stripe
// A candidate reaching "drafted" is the end of the line.
//
// AUTH: CRON_SECRET Bearer only, fail closed on both sides. No query tokens.
// Drafting is gated by a separate ks:draft:cfg that defaults OFF.
//
// RUN IDENTITY: per UTC hour. The cron is scheduled 4x/day; each scheduled
// invocation gets its own run (and its own draftsPerRun budget), while a
// same-hour retry replays the same run idempotently.
import { runDraftAutonomy } from '../lib/draft-autonomy.js';
import { cronAuthorized } from '../lib/cron-auth.js';

export default async function handler(req, res) {
  if (!cronAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const result = await runDraftAutonomy();
    res.status(200).json({ ok: result.reason === 'completed' || result.reason === 'caught_up' || result.reason === 'no_work' || result.reason === 'disabled' || result.reason === 'incomplete_config' || result.reason === 'lease_held', ...result });
  } catch (e) {
    console.error('[cron-draft]', e);
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
