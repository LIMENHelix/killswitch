// Customer-facing inbound signup. No authentication needed.
//
// POST /api/inbound   body: { email, business, phone }
//   -> { ok, portalUrl, message }
//
// Creates account, sends panel link, logs the lead.
// No operator step needed: fully autonomous signup.

import { onboardCustomer } from '../lib/onboard.js';
import { getLeads, saveLeads } from '../lib/store.js';
import { limited, LIMITS } from '../lib/ratelimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (await limited(req, res, { bucket: 'inbound', ...LIMITS.signup })) return;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  const email = String(body.email || '').trim().toLowerCase();
  const business = String(body.business || '').trim();
  const phone = String(body.phone || '').trim();

  if (!email || email.indexOf('@') < 1) {
    res.status(400).json({ error: 'valid_email' });
    return;
  }
  if (!business) {
    res.status(400).json({ error: 'business_required' });
    return;
  }

  const host = (req.headers && (req.headers.origin || (req.headers.host && ('https://' + req.headers.host)))) || 'https://killswitchwebsites.com';

  let out;
  try {
    // Onboard with the business name so account-to-site join can happen
    out = await onboardCustomer({
      email, site: business, name: business, phone,
      host,
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
    const leads = await getLeads();
    leads.push({
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
    await saveLeads(leads);
  } catch (e) {
    console.error('[inbound] log lead', e);
    // Not fatal. Customer got their account.
  }

  res.status(200).json({
    ok: true,
    email: out.email,
    portalUrl: out.portalUrl,
    message: 'Account created. Panel link sent to ' + out.email + '.',
  });
}
