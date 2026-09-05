// Weekly operating scorecard. Every number here is derived from a durable
// internal event; data that still lives in an external dashboard is named as a
// gap rather than guessed or reported as zero.
import { getLeads } from './store.js';
import { listSites } from './sites.js';
import { getFunnel } from './funnel.js';
import { getLifecycleStates } from './lifecycle.js';
import { listBillingEvents } from './billing-events.js';
import { listSuppressions } from './suppression.js';
import { listWorkOrders } from './work-orders.js';
import { listContacts } from './crm.js';
import { listDeadLetters } from './automation.js';

export const SCORECARD_TIME_ZONE = 'America/Chicago';

function zonedParts(date, timeZone = SCORECARD_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function offsetAt(instant, timeZone) {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return asUtc - Math.floor(instant.getTime() / 60000) * 60000;
}

function localMidnightUtc(year, month, day, timeZone) {
  const wanted = Date.UTC(year, month - 1, day, 0, 0);
  let guess = wanted;
  for (let i = 0; i < 3; i++) guess = wanted - offsetAt(new Date(guess), timeZone);
  return new Date(guess);
}

const dateLabel = (date) => date.toISOString().slice(0, 10);

export function previousCompleteWeek(now = new Date(), timeZone = SCORECARD_TIME_ZONE) {
  const p = zonedParts(now, timeZone);
  const localDate = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  const daysFromMonday = (localDate.getUTCDay() + 6) % 7;
  const endLocal = new Date(localDate.getTime() - daysFromMonday * 86400000);
  const startLocal = new Date(endLocal.getTime() - 7 * 86400000);
  const start = localMidnightUtc(startLocal.getUTCFullYear(), startLocal.getUTCMonth() + 1, startLocal.getUTCDate(), timeZone);
  const end = localMidnightUtc(endLocal.getUTCFullYear(), endLocal.getUTCMonth() + 1, endLocal.getUTCDate(), timeZone);
  return { start: start.toISOString(), end: end.toISOString(), startDate: dateLabel(startLocal), endDate: dateLabel(endLocal), timeZone };
}

export function isReviewWindow(now = new Date(), timeZone = SCORECARD_TIME_ZONE) {
  const p = zonedParts(now, timeZone);
  return p.weekday === 'Mon' && Number(p.hour) === 9;
}

const inPeriod = (at, period) => !!at && String(at) >= period.start && String(at) < period.end;
const email = (value) => String(value || '').trim().toLowerCase();
const pct = (top, bottom) => bottom ? +(top * 100 / bottom).toFixed(1) : null;

function groupSignups(signups) {
  const groups = {};
  for (const lead of signups) {
    const attribution = lead.attribution || {};
    const key = [attribution.source || lead.source || 'direct', attribution.medium || 'unknown', attribution.campaign || 'none', lead.trade || 'unknown', lead.city || 'unknown'].join('|');
    groups[key] = (groups[key] || 0) + 1;
  }
  return Object.entries(groups).map(([key, count]) => {
    const [source, medium, campaign, trade, city] = key.split('|');
    return { source, medium, campaign, trade, city, count };
  }).sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
}

export function summarizeWeekly(data, period) {
  const leads = data.leads || [];
  const sites = data.sites || [];
  const funnel = data.funnel || {};
  const billing = (data.billingEvents || []).filter((event) => inPeriod(event.at, period));
  const suppressions = (data.suppressions || []).filter((record) => inPeriod(record.suppressedAt, period));
  const workOrders = data.workOrders || [];
  const lifecycleStates = data.lifecycleStates || {};
  const deadLetters = (data.deadLetters || []).filter((row) => inPeriod(row.at, period));
  const contacts = data.contacts || [];

  const signups = leads.filter((lead) => inPeriod(lead.createdAt, period)
    && email(lead.email).includes('@')
    && (lead.source === 'homepage-inbound' || String(lead.id || '').startsWith('inbound-')));
  const signupEmails = new Set(signups.map((lead) => email(lead.email)));
  const claimedEmails = new Set(sites.filter((site) => site.claimed && signupEmails.has(email(site.email))).map((site) => email(site.email)));
  const completedPayments = billing.filter((event) => event.type === 'payment.completed' && event.amountCents > 0);
  const activatedEmails = new Set(completedPayments.map((event) => email(event.email)).filter(Boolean));
  const cohortPaid = new Set([...claimedEmails].filter((value) => activatedEmails.has(value)));

  const touches = [];
  for (const record of Object.values(funnel)) {
    for (const touch of record.touches || []) if (inPeriod(touch.ts, period)) touches.push(touch);
  }
  const spendCents = touches.reduce((sum, touch) => sum + (Number(touch.costCents) || 0), 0);
  const entries = contacts.flatMap((contact) => contact.entries || []).filter((entry) => inPeriod(entry.at, period));
  const refunds = billing.filter((event) => event.type === 'payment.refunded');
  const disputeSources = new Set(billing.filter((event) => event.type === 'payment.dispute.created').map((event) => event.sourceId || event.id));

  return {
    period,
    owner: 'KS_NOTIFY_EMAIL',
    reviewTime: 'Monday 9:00 AM America/Chicago',
    acquisition: {
      validSignups: signups.length,
      claimedSites: claimedEmails.size,
      signupToClaimedRate: pct(claimedEmails.size, signups.length),
      paidActivations: activatedEmails.size,
      claimedToPaidRate: pct(cohortPaid.size, claimedEmails.size),
      breakdown: groupSignups(signups),
    },
    activity: {
      calls: touches.filter((touch) => touch.channel === 'call').length,
      bookings: entries.filter((entry) => entry.kind === 'booking').length,
      enquiries: entries.filter((entry) => entry.kind === 'message').length,
      suppressionRequests: suppressions.length,
    },
    economics: {
      trackedSpendCents: spendCents,
      costPerValidSignupCents: signups.length ? Math.round(spendCents / signups.length) : null,
      costPerActivatedCustomerCents: activatedEmails.size ? Math.round(spendCents / activatedEmails.size) : null,
      collectedCents: completedPayments.reduce((sum, event) => sum + event.amountCents, 0),
      refundedCents: refunds.reduce((sum, event) => sum + event.amountCents, 0),
    },
    operations: {
      paymentFailures: billing.filter((event) => event.type === 'payment.failed').length,
      refunds: refunds.length,
      disputes: disputeSources.size,
      failedWebhooks: billing.filter((event) => event.type === 'webhook.failed').length,
      deadLetters: deadLetters.length,
      completedWorkOrders: workOrders.filter((order) => order.status === 'completed' && inPeriod(order.completedAt, period)).length,
      openWorkOrders: workOrders.filter((order) => order.status === 'open').length,
      blockedCustomers: Object.values(lifecycleStates).filter((state) => state && state.status === 'blocked').length,
    },
    externalInputs: [
      'Google Search Console impressions, clicks, CTR, and average position',
      'Vercel Web Analytics human visits and landing pages',
      'Google Ads spend (campaign remains disabled pending budget approval)',
    ],
  };
}

export async function collectWeeklyScorecard(now = new Date()) {
  const period = previousCompleteWeek(now);
  const [leads, sites, funnel, billingEvents, suppressions, workOrders, lifecycleStates, deadLetters] = await Promise.all([
    getLeads(), listSites(), getFunnel(), listBillingEvents({ since: period.start, until: period.end, limit: 2500 }),
    listSuppressions({ activeOnly: false }), listWorkOrders(500), getLifecycleStates(), listDeadLetters(2500),
  ]);
  const contacts = [];
  for (let i = 0; i < sites.length; i += 20) {
    const rows = await Promise.all(sites.slice(i, i + 20).map((site) => listContacts(site.slug).catch(() => [])));
    contacts.push(...rows.flat());
  }
  return summarizeWeekly({ leads, sites, funnel, billingEvents, suppressions, workOrders, lifecycleStates, deadLetters, contacts }, period);
}
