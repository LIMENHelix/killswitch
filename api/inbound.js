// Customer-facing inbound signup. No authentication needed.
//
// POST /api/inbound   body: { email, business, phone }
//   -> { ok, portalUrl, message }
//
// Creates account, sends panel link, logs the lead.
// No operator step needed: fully autonomous signup.

import { onboardCustomer } from '../lib/onboard.js';
import { appendInboundLead } from '../lib/store.js';
import { limited, LIMITS } from '../lib/ratelimit.js';
import { ensureCustomerSite } from '../lib/autonomy.js';
import { publicOrigin } from '../lib/origin.js';
import crypto from 'node:crypto';

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

  let out;
  let provisioned;
  try {
    // The shared template is immediately usable, so site creation belongs in
    // the request transaction rather than in an operator queue.
    provisioned = await ensureCustomerSite({ email, business, phone, source: 'inbound-homepage' });
    out = await onboardCustomer({
      email, site: business, name: business, phone,
      source: 'inbound-homepage',
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
      id: crypto.randomUUID(),
      email,
      name: business,
      phone,
      trade: '',
      street: '', city: '', state: '', zip: '',
      status: 'new',
      source: 'homepage-inbound',
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
