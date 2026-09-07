// Customer-facing inbound signup. No authentication needed.
//
// POST /api/inbound   body: { email, business, phone, name?, trade?, area?,
//                             domain?, interests?, notes?, attribution? }
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
  const name = String(body.name || '').trim();
  const trade = String(body.trade || '').trim();
  const area = String(body.area || '').trim();
  const domain = String(body.domain || '').trim();
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

  if (name.length > 120 || trade.length > 80 || area.length > 120 || domain.length > 160) {
    res.status(400).json({ error: 'intake_fields_too_long' });
    return;
  }
  if (notes.length > 2000) {
    res.status(400).json({ error: 'notes_too_long' });
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
    provisioned = await ensureCustomerSite({ email, business, phone, trade, city: area, source: 'inbound-homepage' });
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
      street: '', city: area, state: '', zip: '',
      domain,
      interests,
      notes,
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
