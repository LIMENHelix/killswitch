// Customer-facing inbound signup. No authentication needed.
//
// POST /api/inbound   body: { email, business, phone, name?, trade?, city?,
//                     state?, area?(legacy alias for city), street?, zip?,
//                     publicEmail?, domain?, services?, hours?, about?,
//                     interests?, notes?, attribution? }
//   -> { ok, siteUrl, email, message }
//
// The /start intake form posts here. It creates the free (P0-only) site, the
// account, and the lead-board row in our own storage, and sends the panel link.
// Paid-module checkboxes on the form arrive as `interests`: they are recorded
// on the lead row so a rep can see them, and NEVER touch modules[], entitlements,
// Stripe, or checkout. No operator step needed: fully autonomous signup.

import { onboardCustomer } from '../lib/onboard.js';
import { appendInboundLead } from '../lib/store.js';
import { limited, LIMITS } from '../lib/ratelimit.js';
import { ensureCustomerSite } from '../lib/autonomy.js';
import { publicOrigin } from '../lib/origin.js';
import { normalizeAttribution } from '../lib/attribution.js';
import { recordLifecycle } from '../lib/lifecycle.js';
import crypto from 'node:crypto';

// The four paid modules /start offers as "starting with" checkboxes. Anything
// else a client submits is not an interest we recognise and is dropped, the
// same way normalizeAttribution drops unknown fields.
const INTEREST_LABELS = ['Get Found on Google', 'Online Booking', 'Payments', '24/7 AI Assistant'];

// ---- services / hours normalisation ----------------------------------------
// The /start form sends these as plain text (one entry per line); API callers
// may send arrays of strings or objects. ONE parser both places use, so the
// textarea and the API can never disagree about what a line means. Throws with
// a stable code on input that is structurally wrong or over the caps; blank
// lines are parsing, not data, and are skipped.

const SERVICES_MAX = 24, SERVICE_NAME_MAX = 80, SERVICE_DESC_MAX = 200;
const HOURS_MAX = 14, HOUR_DAY_MAX = 40, HOUR_TIME_MAX = 60;

/**
 * @param {unknown} input array of strings / {name, desc} / {d, h}, or a
 *   newline-separated string.
 * @returns {Array<{name:string, desc:string}>}
 * @throws {Error} code in .message when the input is unusable or over caps.
 */
export function parseServiceLines(input) {
  if (input === undefined || input === null || input === '') return [];
  const items = Array.isArray(input) ? input : String(input).split(/\r?\n/);
  if (items.length > SERVICES_MAX) throw new Error('services_invalid');
  const out = [];
  for (const item of items) {
    let name = '', desc = '';
    if (item && typeof item === 'object') {
      name = String(item.name || '').trim();
      desc = String(item.desc || '').trim();
    } else {
      const line = String(item == null ? '' : item).trim();
      if (!line) continue;
      // "Brake repair — we pick up your car": an em/en dash splits name/desc.
      const cut = line.split(/\s+[—–]\s+/);
      name = (cut[0] || '').trim();
      desc = (cut.slice(1).join(' — ') || '').trim();
    }
    if (!name) continue;
    if (name.length > SERVICE_NAME_MAX || desc.length > SERVICE_DESC_MAX) throw new Error('services_invalid');
    out.push({ name, desc });
  }
  if (out.length > SERVICES_MAX) throw new Error('services_invalid');
  return out;
}

/**
 * Hours, same contract: "Mon to Fri: 8am to 6pm" per line, or {d, h} objects.
 * @returns {Array<{d:string, h:string}>}
 */
export function parseHourLines(input) {
  if (input === undefined || input === null || input === '') return [];
  const items = Array.isArray(input) ? input : String(input).split(/\r?\n/);
  if (items.length > HOURS_MAX) throw new Error('hours_invalid');
  const out = [];
  for (const item of items) {
    let d = '', h = '';
    if (item && typeof item === 'object') {
      d = String(item.d || '').trim();
      h = String(item.h || '').trim();
    } else {
      const line = String(item == null ? '' : item).trim();
      if (!line) continue;
      const cut = line.indexOf(':');
      if (cut < 0) { d = line; h = ''; }
      else { d = line.slice(0, cut).trim(); h = line.slice(cut + 1).trim(); }
    }
    if (!d) continue;
    if (d.length > HOUR_DAY_MAX || h.length > HOUR_TIME_MAX) throw new Error('hours_invalid');
    out.push({ d, h });
  }
  if (out.length > HOURS_MAX) throw new Error('hours_invalid');
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (await limited(req, res, { bucket: 'inbound', ...LIMITS.inbound })) return;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  const email = String(body.email || '').trim().toLowerCase();
  const business = String(body.business || '').trim();
  const phone = String(body.phone || '').trim();
  const attribution = normalizeAttribution(body.attribution);

  // Factual intake details from /start. All optional; all length-capped so a
  // public endpoint cannot write unbounded payloads into customer records.
  // `area` is the legacy field the first slice shipped; explicit city wins.
  const name = String(body.name || '').trim();
  const trade = String(body.trade || '').trim();
  const city = String(body.city || body.area || '').trim();
  const state = String(body.state || '').trim();
  const street = String(body.street || '').trim();
  const zip = String(body.zip || '').trim();
  const publicEmail = String(body.publicEmail || '').trim();
  const domain = String(body.domain || '').trim();
  const about = String(body.about || '').trim();
  const notes = String(body.notes || '').trim();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: 'valid_email' });
    return;
  }
  if (business.length < 2 || business.length > 120) {
    res.status(400).json({ error: 'business_required' });
    return;
  }

  if (phone.replace(/\D/g, '').length < 10 || phone.length > 40) {
    res.status(400).json({ error: 'valid_phone' });
    return;
  }

  if (name.length > 120 || trade.length > 80 || city.length > 120 || state.length > 40
    || street.length > 160 || zip.length > 20 || domain.length > 160 || publicEmail.length > 120) {
    res.status(400).json({ error: 'intake_fields_too_long' });
    return;
  }
  if (about.length > 600) {
    res.status(400).json({ error: 'about_too_long' });
    return;
  }
  if (notes.length > 2000) {
    res.status(400).json({ error: 'notes_too_long' });
    return;
  }
  // The email a customer wants SHOWN on their public site. Same shape as the
  // contact email; garbage here would render on a live page.
  if (publicEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(publicEmail)) {
    res.status(400).json({ error: 'valid_public_email' });
    return;
  }

  let services = [];
  let hours = [];
  try {
    services = parseServiceLines(body.services);
    hours = parseHourLines(body.hours);
  } catch (e) {
    // Structurally wrong or over the caps: say which, do not silently drop.
    res.status(400).json({ error: String(e && e.message || 'invalid_intake_list') });
    return;
  }

  // INTERESTS ONLY. A checkbox is a customer telling us what they are curious
  // about, not a purchase; it lands on the lead row and never near modules[].
  let interests = [];
  if (body.interests !== undefined) {
    if (!Array.isArray(body.interests)) {
      res.status(400).json({ error: 'interests_must_be_array' });
      return;
    }
    interests = body.interests
      .map((i) => String(i || '').trim())
      .filter((i) => i && i.length <= 60 && INTEREST_LABELS.includes(i))
      .slice(0, 10);
  }

  // SERVER-GENERATED, never read from the client: the moment we received an
  // intake whose form requires the Terms checkbox. A client-sent timestamp is
  // ignored on purpose — proof of consent is ours to record, not theirs.
  const termsAcceptedAt = new Date().toISOString();

  let out;
  let provisioned;
  // Stable across HTTP/Stripe retries so one real prospect is one lead and one
  // lifecycle event, not a new row each time a response is retried.
  const leadId = 'inbound-' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 20);
  try {
    await recordLifecycle(email, {
      type: 'lead.received', stage: 'lead_received', idempotencyKey: 'inbound:lead',
      data: { business, source: 'homepage-inbound', attribution },
    });
    // The shared template is immediately usable, so site creation belongs in
    // the request transaction rather than in an operator queue.
    provisioned = await ensureCustomerSite({
      email, business, phone, trade, city, state, street, zip,
      emailPublic: publicEmail, services, hours, about,
      source: 'inbound-homepage',
    });
    await recordLifecycle(email, {
      type: 'site.published', stage: 'site_published', idempotencyKey: 'inbound:site-published',
      data: { siteSlug: provisioned.site.slug, created: provisioned.created },
    });
    out = await onboardCustomer({
      email, site: business, name: name || business, phone,
      source: 'inbound-homepage', leadId,
    });
  } catch (e) {
    console.error('[inbound] onboard', e);
    res.status(500).json({ error: 'server_error' });
    return;
  }

  if (out.error) {
    res.status(400).json({ error: out.error });
    return;
  }

  // Log the lead so reps can see it on their board (no assignment yet,
  // first rep to move it owns it). Fire-and-forget: logging must never block signup.
  try {
    await appendInboundLead({
      id: leadId,
      email,
      name: business,
      contactName: name,
      phone,
      trade,
      street, city, state, zip,
      publicEmail,
      domain,
      services,
      hours,
      about,
      interests,
      notes,
      termsAcceptedAt,
      status: 'new',
      source: 'homepage-inbound',
      attribution,
      createdAt: new Date().toISOString(),
      // Contact flow captures these at once, not later.
      owner: null,
    });
  } catch (e) {
    console.error('[inbound] log lead', e);
    // Not fatal. Customer got their account.
  }

  res.status(200).json({
    ok: true,
    email: out.email,
    siteUrl: publicOrigin() + '/s/' + provisioned.site.slug,
    message: 'Website created. Private panel link sent to ' + out.email + '.',
  });
}
