// P6 Marketing Automation: the follow-ups that happen without anyone remembering.
//
// Sold as "the follow-up messages, reminders, and review requests that win you
// repeat business get sent automatically". This is that, built on the two events
// a customer site actually produces: an enquiry and a booking request.
//
// WHAT IT SENDS, and nothing beyond it:
//   1. an immediate acknowledgement, from the business, so nobody waits in silence
//   2. a review request 3 days later, which is the ask that gets forgotten most
//
// A QUEUE, not a send-now, because the second one is due in three days and a
// serverless function cannot wait. Items sit in a Redis sorted-set-by-time list
// and /api/cron-followups drains whatever is due. Nothing is ever sent early.
//
// ONLY TO PEOPLE WHO GAVE US AN EMAIL. Most enquiries leave a phone number, and
// there is no SMS here: cold or automated SMS is TCPA territory and this is not
// the place to find out. A contact with no email simply queues nothing.
import { cmd, pipeline } from './kv.js';
import { externalSideEffectsAllowed } from './environment.js';

const QUEUE = 'ks:auto:q';           // sorted set, score = due timestamp (ms)
const ITEM = (id) => 'ks:auto:i:' + id;
const SENT = 'ks:auto:sent';         // hash, id -> ISO sent time, for the panel
const DEAD = 'ks:auto:dead';         // hash, id -> terminal failure details
const CLAIM = (id) => 'ks:auto:claim:' + id;

const DAY = 86400000;

// The two steps, and how long after the trigger each is due.
export const STEPS = [
  { id: 'ack', delayMs: 0, label: 'Thank you, we got your message' },
  { id: 'review', delayMs: 3 * DAY, label: 'How did we do?' },
];

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const isEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || '').trim());

/**
 * Durable dedupe + queue entry for one item. The item record IS the dedupe
 * marker (SET NX), the sorted set drives delivery (ZADD NX).
 *
 * These are two independent Redis commands, not a transaction: a partial
 * pipeline failure, or the sequential fallback between the two HTTP writes,
 * can leave the durable marker standing WITHOUT a queue entry. That state is
 * invisible to dueItems (which enumerates the set) and would silently
 * suppress the reminder forever — a later schedule would see SET NX fail and
 * give up. So when the marker already exists we do NOT count a new item, but
 * we DO verify the marker is actually queued and repair it from its own
 * durable payload. This is the one place that can observe the orphan.
 *
 * @returns {Promise<boolean>} true only when a NEW item was queued
 */
async function enqueueItem(item) {
  // SET first, alone: the marker must exist before anything references it, and
  // a re-schedule must never reset the due time of work already counting down.
  const setRes = await cmd(['SET', ITEM(item.id), JSON.stringify(item), 'NX']);
  if (setRes === 'OK') {
    await cmd(['ZADD', QUEUE, 'NX', String(item.due), item.id]);
    return true;
  }
  // The marker already exists. If a partial failure orphaned it (marker without
  // a queue entry), repair membership from the durable payload itself — keeping
  // its ORIGINAL due, never re-basing the clock on a later scheduler pass.
  try {
    const raw = await cmd(['GET', ITEM(item.id)]);
    if (!raw) return false;
    const existing = JSON.parse(raw);
    await cmd(['ZADD', QUEUE, 'NX', String(Number(existing.due) || item.due), item.id]);
  } catch { /* unreadable marker: leave the state untouched rather than guess */ }
  return false;
}

/**
 * Queue the follow-up sequence for one enquiry.
 * Never throws at the call site's expense: this runs behind a customer's
 * contact form and must not be able to break it.
 *
 * @param {object} site   the site record (business, slug, phone, email)
 * @param {object} o      { name, handle, kind }
 * @param {number} [now]  ms, injected so the schedule is testable
 */
export async function queueFollowUps(site, { name, handle, kind }, now = Date.now()) {
  if (!site || !site.slug) return 0;
  if (!isEmail(handle)) return 0;   // nothing to send to, and we do not text

  const cmds = [];
  let queued = 0;
  for (const step of STEPS) {
    // One of each step per person per site, so a repeat enquiry does not stack
    // up four review requests on the same customer. NX so a second enquiry
    // never resets a review request that is already counting down.
    cmds.push({
      id: `${site.slug}:${contactKey(handle)}:${step.id}`,
      slug: site.slug, step: step.id, due: now + step.delayMs,
      business: clip(site.business, 120),
      businessPhone: clip(site.phone, 40),
      to: clip(handle, 120), name: clip(name, 80), kind: kind || 'message',
      queuedAt: new Date(now).toISOString(),
    });
  }
  for (const item of cmds) {
    if (await enqueueItem(item)) queued++;
  }
  return queued;
}

function contactKey(handle) {
  return String(handle || '').toLowerCase().replace(/[^a-z0-9@.]/g, '').slice(0, 60);
}

// The ONE bounded reminder that a free site's owner gets: their site is ready,
// here is your panel link. Delayed by the same 3-day cadence the review step
// already uses, and exactly one per owner per site — NX below makes a repeat
// delivery a no-op rather than a second reminder.
export const CLAIM_REMINDER_DELAY_MS = 3 * DAY;

/**
 * Queue the single claim reminder for a freshly delivered free site.
 * Never throws at the call site's expense, same contract as queueFollowUps.
 *
 * @param {object} site  the site record (slug, business, phone)
 * @param {object} o     { email }
 * @param {number} [now] ms, injected so the schedule is testable
 * @returns {Promise<boolean>} whether a new item was queued
 */
export async function queueClaimReminder(site, { email }, now = Date.now()) {
  if (!site || !site.slug) return false;
  if (!isEmail(email)) return false;
  const id = `${site.slug}:claim:${contactKey(email)}`;
  const item = {
    id, slug: site.slug, step: 'claimremind', due: now + CLAIM_REMINDER_DELAY_MS,
    business: clip(site.business, 120),
    businessPhone: clip(site.phone, 40),
    to: clip(email, 120), name: '', kind: 'claimremind',
    queuedAt: new Date(now).toISOString(),
  };
  return enqueueItem(item);
}

/** Everything due at or before `now`, oldest first. */
export async function dueItems(now = Date.now(), limit = 50) {
  const ids = await cmd(['ZRANGEBYSCORE', QUEUE, '-inf', String(now), 'LIMIT', '0', String(limit)]);
  const list = Array.isArray(ids) ? ids : [];
  if (!list.length) return [];
  const raw = await pipeline(list.map((id) => ['GET', ITEM(id)]));
  return raw.map((r, i) => {
    if (!r) return null;
    try { return JSON.parse(r); } catch { return null; }
  }).filter(Boolean).map((it, i) => it);
}

/** Take an item off the queue once it has been dealt with. */
export async function retire(id, sentAt) {
  await pipeline([
    ['ZREM', QUEUE, id],
    ['DEL', ITEM(id)],
    ['HSET', SENT, id, sentAt || new Date().toISOString()],
  ]);
}

/** A short lease makes concurrent cron invocations safe. */
export async function claimItem(id) {
  return (await cmd(['SET', CLAIM(id), new Date().toISOString(), 'NX', 'EX', '300'])) === 'OK';
}

export async function releaseItem(id) {
  await cmd(['DEL', CLAIM(id)]);
}

export async function deadLetter(item, reason) {
  await cmd(['HSET', DEAD, item.id, JSON.stringify({ item, reason, at: new Date().toISOString() })]);
}

// Bounded autonomy: a transient provider failure retries, but not forever.
// After this many CONSECUTIVE transient failures the item is dead-lettered
// exactly like a hard rejection, so a persistently unreachable provider or a
// swallowed outage can never spin the cron every five minutes indefinitely.
export const MAX_SEND_ATTEMPTS = 3;

/** Persist the next attempt count on a queued item. Returns the new count. */
export async function recordAttempt(item) {
  const attempts = (Number(item.attempts) || 0) + 1;
  try {
    await cmd(['SET', ITEM(item.id), JSON.stringify({ ...item, attempts })]);
  } catch (e) { console.error('[automation] attempt', item.id, e); }
  return attempts;
}

export async function listDeadLetters(limit = 500) {
  const all = await cmd(['HGETALL', DEAD]);
  const parsed = {};
  if (Array.isArray(all)) {
    for (let i = 0; i + 1 < all.length; i += 2) {
      try { parsed[all[i]] = JSON.parse(all[i + 1]); } catch { /* ignore malformed rows */ }
    }
  } else if (all && typeof all === 'object') {
    for (const [id, value] of Object.entries(all)) {
      try { parsed[id] = typeof value === 'string' ? JSON.parse(value) : value; } catch { /* ignore malformed rows */ }
    }
  }
  return Object.values(parsed).filter(Boolean)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, Math.min(Math.max(1, Number(limit) || 500), 2500));
}

export function bodyFor(item) {
  const who = item.name ? item.name.split(' ')[0] : 'there';
  const biz = item.business || 'us';
  if (item.step === 'ack') {
    return {
      subject: `Thanks for getting in touch with ${biz}`,
      lines: [
        `Hi ${who},`,
        item.kind === 'booking'
          ? `Thanks for asking to book with ${biz}. We have your request and someone will confirm your time shortly.`
          : `Thanks for your message. We have it, and someone at ${biz} will come back to you shortly.`,
        item.businessPhone ? `If it is urgent, call us on ${item.businessPhone}.` : '',
      ].filter(Boolean),
    };
  }
  return {
    subject: `How did we do, ${who}?`,
    lines: [
      `Hi ${who},`,
      `You got in touch with ${biz} a few days ago. If we looked after you, a short review makes a real difference to a small business, and it takes a minute.`,
      `If something was not right, reply to this email and we will put it straight.`,
      item.businessPhone ? `You can always reach us on ${item.businessPhone}.` : '',
    ].filter(Boolean),
  };
}

/**
 * Send one queued item. Returns why it did not send rather than throwing, so
 * one bad address cannot stop the rest of the run.
 */
export async function sendItem(item) {
  if (!externalSideEffectsAllowed()) return { sent: false, reason: 'preview_side_effects_disabled' };
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: 'no_api_key' };
  const { subject, lines } = bodyFor(item);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'content-type': 'application/json',
        // Resend guarantees the same queue item cannot become two emails if a
        // function times out after sending but before it retires the item.
        'Idempotency-Key': 'ks-followup/' + String(item.id || '').slice(0, 220),
      },
      body: JSON.stringify({
        // Sent in the BUSINESS's name, because it is their follow-up, not ours.
        from: process.env.KS_FROM_EMAIL || 'Killswitch Websites <hello@killswitch.domains>',
        reply_to: item.businessEmail || undefined,
        to: [item.to],
        subject,
        html: '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;color:#1E1B16">'
          + lines.map((l) => `<p style="margin:0 0 10px">${esc(l)}</p>`).join('')
          + `<p style="color:#9A9284;font-size:12px;margin-top:20px">Sent by ${esc(item.business)}.</p>`
          + '</div>',
      }),
    });
    if (!r.ok) return { sent: false, reason: 'resend_' + r.status };
    return { sent: true };
  } catch (e) {
    console.error('[automation] send', e);
    return { sent: false, reason: 'threw' };
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** What the panel shows: how many are waiting and how many have gone out. */
export async function statsFor(slug) {
  const s = String(slug || '').trim();
  const ids = await cmd(['ZRANGE', QUEUE, '0', '-1']);
  const pending = (Array.isArray(ids) ? ids : []).filter((id) => String(id).startsWith(s + ':')).length;
  const sentAll = await cmd(['HKEYS', SENT]);
  const sent = (Array.isArray(sentAll) ? sentAll : []).filter((id) => String(id).startsWith(s + ':')).length;
  return { pending, sent };
}
