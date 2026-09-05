// Monday operating review, delivered at 9 AM America/Chicago year-round.
// Vercel schedules the two possible UTC hours; the timezone gate below sends at
// exactly one of them, and a durable marker makes retries idempotent.
import { collectWeeklyScorecard, isReviewWindow, previousCompleteWeek } from '../lib/scorecard.js';
import { notifyOperator } from '../lib/notify.js';
import { cmd, pipeline } from '../lib/kv.js';
import { identify, isOwner } from '../lib/roles.js';
import { publicOrigin } from '../lib/origin.js';

export const config = { maxDuration: 60 };

const usd = (cents) => '$' + ((Number(cents) || 0) / 100).toFixed(2);

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers && req.headers.authorization || '';
  const token = req.query && req.query.token || '';
  const cron = !!secret && auth === 'Bearer ' + secret;
  const owner = isOwner(identify(token));
  if (!cron && !owner) { res.status(401).json({ error: 'unauthorized' }); return; }

  const now = new Date();
  if (cron && !isReviewWindow(now)) {
    res.status(200).json({ ok: true, sent: false, reason: 'outside_chicago_review_hour' });
    return;
  }

  const period = previousCompleteWeek(now);
  const sentKey = 'ks:scorecard:sent:' + period.endDate;
  const claimKey = 'ks:scorecard:claim:' + period.endDate;
  if (await cmd(['GET', sentKey])) {
    res.status(200).json({ ok: true, sent: false, duplicate: true, period });
    return;
  }
  const claimed = await cmd(['SET', claimKey, now.toISOString(), 'NX', 'EX', '900']);
  if (claimed !== 'OK') { res.status(200).json({ ok: true, sent: false, busy: true, period }); return; }

  try {
    const report = await collectWeeklyScorecard(now);
    const a = report.acquisition, activity = report.activity, economics = report.economics, operations = report.operations;
    const notice = await notifyOperator({
      subject: `Weekly Killswitch scorecard - ${report.period.startDate} to ${report.period.endDate}`,
      heading: 'Your weekly operating scorecard is ready',
      lines: [
        `Period: ${report.period.startDate} through ${report.period.endDate} (end exclusive)`,
        `Valid signups: ${a.validSignups} | claimed sites: ${a.claimedSites} | paid activations: ${a.paidActivations}`,
        `Signup to claimed: ${a.signupToClaimedRate == null ? 'n/a' : a.signupToClaimedRate + '%'} | claimed to paid: ${a.claimedToPaidRate == null ? 'n/a' : a.claimedToPaidRate + '%'}`,
        `Calls: ${activity.calls} | bookings: ${activity.bookings} | enquiries: ${activity.enquiries} | suppression requests: ${activity.suppressionRequests}`,
        `Tracked spend: ${usd(economics.trackedSpendCents)} | collected: ${usd(economics.collectedCents)} | refunded: ${usd(economics.refundedCents)}`,
        `Payment failures: ${operations.paymentFailures} | disputes: ${operations.disputes} | failed webhooks: ${operations.failedWebhooks}`,
        `Open work orders: ${operations.openWorkOrders} | blocked customers: ${operations.blockedCustomers} | dead letters: ${operations.deadLetters}`,
        'Search Console and Vercel Web Analytics remain external dashboard inputs and are not guessed in this email.',
        'Google Ads remains disabled until a budget and stop-loss are approved.',
      ],
      url: publicOrigin() + '/master', urlText: 'Open the full scorecard',
    });
    if (!notice.sent) {
      await cmd(['DEL', claimKey]);
      res.status(500).json({ error: 'scorecard_delivery_failed', reason: notice.reason || 'unknown' });
      return;
    }
    await pipeline([
      ['SET', sentKey, now.toISOString(), 'EX', String(400 * 86400)],
      ['SET', 'ks:scorecard:last', JSON.stringify({ sentAt: now.toISOString(), report })],
      ['DEL', claimKey],
    ]);
    res.status(200).json({ ok: true, sent: true, report });
  } catch (error) {
    await cmd(['DEL', claimKey]).catch(() => {});
    console.error('[cron-scorecard]', error);
    res.status(500).json({ error: 'scorecard_failed' });
  }
}
