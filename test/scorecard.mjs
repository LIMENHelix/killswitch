import { isReviewWindow, previousCompleteWeek, summarizeWeekly } from '../lib/scorecard.js';

let passed = 0, failed = 0;
function check(name, condition, detail = '') {
  if (condition) { console.log('  PASS  ' + name); passed++; }
  else { console.log('  FAIL  ' + name + (detail ? ' <- ' + detail : '')); failed++;
  }
}

console.log('\nTHE WEEK IS A COMPLETE CHICAGO BUSINESS WEEK');
const summer = previousCompleteWeek(new Date('2026-09-04T18:00:00Z'));
check('the current partial week is excluded', summer.startDate === '2026-08-24' && summer.endDate === '2026-08-31', JSON.stringify(summer));
check('summer midnight carries the daylight offset', summer.start === '2026-08-24T05:00:00.000Z');
const winter = previousCompleteWeek(new Date('2026-12-09T18:00:00Z'));
check('winter midnight carries the standard-time offset', winter.start.endsWith('T06:00:00.000Z'), JSON.stringify(winter));
check('9 AM Monday is selected in summer', isReviewWindow(new Date('2026-09-07T14:00:00Z')));
check('the second UTC slot is skipped in summer', !isReviewWindow(new Date('2026-09-07T15:00:00Z')));
check('9 AM Monday is selected in winter', isReviewWindow(new Date('2026-12-07T15:00:00Z')));
check('the first UTC slot is skipped in winter', !isReviewWindow(new Date('2026-12-07T14:00:00Z')));

console.log('\nTHE SCORECARD COUNTS MEASURED BUSINESS EVENTS, NOT PAGEVIEWS');
const period = { start: '2026-08-24T05:00:00.000Z', end: '2026-08-31T05:00:00.000Z', startDate: '2026-08-24', endDate: '2026-08-31', timeZone: 'America/Chicago' };
const report = summarizeWeekly({
  leads: [
    { id: 'inbound-a', email: 'a@example.com', source: 'homepage-inbound', createdAt: '2026-08-25T10:00:00Z', trade: 'plumber', city: 'Kansas City', attribution: { source: 'google', medium: 'organic', campaign: 'kc-free-site' } },
    { id: 'inbound-b', email: 'b@example.com', source: 'homepage-inbound', createdAt: '2026-08-26T10:00:00Z', trade: 'electrician', city: 'Lenexa', attribution: { source: 'postcard', medium: 'direct-mail', campaign: 'kc-free-site' } },
    { id: 'outbound-c', email: 'c@example.com', source: 'places', createdAt: '2026-08-27T10:00:00Z' },
    { id: 'inbound-old', email: 'old@example.com', source: 'homepage-inbound', createdAt: '2026-08-01T10:00:00Z' },
  ],
  sites: [
    { email: 'a@example.com', claimed: true },
    { email: 'b@example.com', claimed: false },
  ],
  funnel: {
    a: { touches: [{ ts: '2026-08-25T12:00:00Z', channel: 'call', costCents: 0 }, { ts: '2026-08-25T13:00:00Z', channel: 'mailer', costCents: 94 }] },
    b: { touches: [{ ts: '2026-08-26T12:00:00Z', channel: 'call', costCents: 0 }] },
  },
  billingEvents: [
    { id: 'pay-a', type: 'payment.completed', email: 'a@example.com', amountCents: 1900, at: '2026-08-27T10:00:00Z' },
    { id: 'pay-c', type: 'payment.completed', email: 'c@example.com', amountCents: 2900, at: '2026-08-28T10:00:00Z' },
    { id: 'refund-a', sourceId: 're_1', type: 'payment.refunded', email: 'a@example.com', amountCents: 500, at: '2026-08-29T10:00:00Z' },
    { id: 'failed-b', type: 'payment.failed', email: 'b@example.com', amountCents: 1900, at: '2026-08-29T11:00:00Z' },
    { id: 'dispute-a', sourceId: 'dp_1', type: 'payment.dispute.created', email: 'a@example.com', amountCents: 1900, at: '2026-08-29T12:00:00Z' },
    { id: 'hook-x', type: 'webhook.failed', at: '2026-08-29T13:00:00Z' },
  ],
  suppressions: [{ suppressedAt: '2026-08-28T10:00:00Z' }, { suppressedAt: '2026-07-01T10:00:00Z' }],
  workOrders: [
    { status: 'completed', completedAt: '2026-08-29T10:00:00Z' },
    { status: 'open', createdAt: '2026-08-28T10:00:00Z' },
  ],
  lifecycleStates: { a: { status: 'active' }, b: { status: 'blocked' } },
  deadLetters: [{ at: '2026-08-29T10:00:00Z' }],
  contacts: [{ entries: [{ at: '2026-08-27T10:00:00Z', kind: 'booking' }, { at: '2026-08-27T11:00:00Z', kind: 'message' }] }],
}, period);

check('only validated inbound signups count', report.acquisition.validSignups === 2);
check('claimed sites are joined to that signup cohort', report.acquisition.claimedSites === 1);
check('signup to claimed is calculated', report.acquisition.signupToClaimedRate === 50);
check('all paid activations in the week are visible', report.acquisition.paidActivations === 2);
check('claimed to paid uses the claimed signup cohort', report.acquisition.claimedToPaidRate === 100);
check('campaign dimensions survive into the breakdown', report.acquisition.breakdown.some((row) => row.source === 'google' && row.campaign === 'kc-free-site' && row.count === 1));
check('calls are counted from actual touches', report.activity.calls === 2);
check('bookings and enquiries come from customer records', report.activity.bookings === 1 && report.activity.enquiries === 1);
check('suppression requests are period bounded', report.activity.suppressionRequests === 1);
check('tracked fulfillment spend is honest', report.economics.trackedSpendCents === 94);
check('cost per signup uses tracked spend', report.economics.costPerValidSignupCents === 47);
check('collected and refunded money remain separate', report.economics.collectedCents === 4800 && report.economics.refundedCents === 500);
check('payment failures, disputes, and webhook failures are visible', report.operations.paymentFailures === 1 && report.operations.disputes === 1 && report.operations.failedWebhooks === 1);
check('work and lifecycle blockers are visible', report.operations.completedWorkOrders === 1 && report.operations.openWorkOrders === 1 && report.operations.blockedCustomers === 1);
check('dead letters are visible', report.operations.deadLetters === 1);
check('external analytics are named instead of fabricated', report.externalInputs.some((item) => item.includes('Search Console')) && report.externalInputs.some((item) => item.includes('Web Analytics')));
check('the paid-ad gate remains explicit', report.externalInputs.some((item) => item.includes('disabled pending budget')));
check('the review owner and time are assigned', report.owner === 'KS_NOTIFY_EMAIL' && report.reviewTime.includes('Monday 9:00 AM'));

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
