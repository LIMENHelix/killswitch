// Scheduled autopilot mailer. Vercel cron hits this on a schedule (see
// vercel.json). It self-gates: does nothing unless autopilot is ON and under
// the daily cap and budget. Also callable manually with the admin token.
import { runAutopilot } from '../lib/mailer.js';

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  const token = (req.query && req.query.token) || '';
  const okCron = secret ? auth === `Bearer ${secret}` : true; // Vercel adds this header when CRON_SECRET is set
  const okAdmin = [process.env.ADMIN_KEY, process.env.SWITCH_TOKEN].filter(Boolean).includes(token);
  if (!okCron && !okAdmin) { res.status(401).json({ error: 'unauthorized' }); return; }

  try {
    const result = await runAutopilot(okAdmin ? 'manual-cron' : 'cron');
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('[cron-mail]', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
