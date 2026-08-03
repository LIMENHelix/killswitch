// Public actions coming FROM a customer's website: a booking request (P3) and a
// question for their AI assistant (P9). Public by necessity, so both paths are
// module-gated and rate-shaped: if a customer has not paid for the module, the
// endpoint refuses, which stops a switched-off feature being driven by hand.
import { getSite, has } from '../lib/sites.js';
import { notifyOperator } from '../lib/notify.js';

const clean = (v, n = 120) => String(v == null ? '' : v).trim().slice(0, n);

async function emailBusiness(site, subject, lines) {
  const key = process.env.RESEND_API_KEY;
  const to = site.email_public || site.email;
  if (!key || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: process.env.KS_FROM_EMAIL || 'Killswitch Websites <hello@killswitch.domains>',
        to: [to],
        subject,
        html: '<div style="font-family:Arial,sans-serif;max-width:520px;color:#1E1B16">'
          + lines.map((l) => `<p style="margin:0 0 8px">${String(l).replace(/</g, '&lt;')}</p>`).join('')
          + '</div>',
      }),
    });
    return r.ok;
  } catch (e) { console.error('[site-action] email', e); return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  const site = await getSite(body.slug).catch(() => null);
  if (!site || !site.published) { res.status(404).json({ error: 'no_site' }); return; }

  // ---- P3 booking request ----
  if (body.action === 'book') {
    if (!has(site, 'P3')) { res.status(403).json({ error: 'module_off' }); return; }
    const name = clean(body.name, 80), phone = clean(body.phone, 40), when = clean(body.when, 160);
    if (!name || !phone) { res.status(400).json({ error: 'name_and_phone_required' }); return; }

    const lines = [
      `<b>New booking request for ${site.business}</b>`,
      `Name: ${name}`, `Phone: ${phone}`, `Requested: ${when || 'not stated'}`,
      'Call them back to confirm the time.',
    ];
    await emailBusiness(site, `Booking request — ${name}`, lines);
    // Operator copy, so a silent failure at the customer end is still visible.
    await notifyOperator({
      subject: `Booking request on ${site.business}`,
      heading: 'A booking came in through a customer site',
      lines: [`Site: ${site.business} (/s/${site.slug})`, `Name: ${name}`, `Phone: ${phone}`, `Requested: ${when || 'not stated'}`],
    });
    res.status(200).json({ ok: true });
    return;
  }

  // ---- P9 AI assistant ----
  if (body.action === 'ask') {
    if (!has(site, 'P9')) { res.status(403).json({ error: 'module_off' }); return; }
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) { res.status(503).json({ error: 'not_configured' }); return; }

    let messages = Array.isArray(body.messages) ? body.messages : [];
    messages = messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, 600) }))
      .slice(-8);
    while (messages.length && messages[0].role !== 'user') messages.shift();
    if (!messages.length) { res.status(400).json({ error: 'no_message' }); return; }

    // Grounded ONLY in this business's own record, so it cannot invent services
    // or prices the owner never listed.
    const facts = [
      `Business: ${site.business}`,
      site.trade ? `Trade: ${site.trade}` : '',
      site.tagline ? `About: ${site.tagline}` : '',
      site.about ? `More: ${site.about}` : '',
      site.phone ? `Phone: ${site.phone}` : '',
      [site.street, site.city, site.state, site.zip].filter(Boolean).length ? `Address: ${[site.street, site.city, site.state, site.zip].filter(Boolean).join(', ')}` : '',
      site.hours.length ? `Hours: ${site.hours.map((h) => `${h.d} ${h.h}`).join('; ')}` : '',
      site.services.length ? `Services: ${site.services.map((x) => x.name + (x.desc ? ' (' + x.desc + ')' : '')).join('; ')}` : '',
      has(site, 'P3') ? 'They can book online on this website.' : '',
    ].filter(Boolean).join('\n');

    const SYSTEM = `You answer questions for ${site.business} on their own website. You speak as the business, warmly and briefly (1 to 3 sentences).

EVERYTHING YOU KNOW:
${facts}

RULES:
1. Answer ONLY from the facts above. If something is not listed (a price, a service, a policy), say you are not sure and give the phone number so they can ask directly. NEVER invent a service, price, time or policy.
2. Stay on this business. Decline anything unrelated in one short sentence.
3. Never mention or compare other companies.
4. Never use long dashes. Use commas, periods or parentheses.`;

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 260, system: SYSTEM, messages }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { console.error('[site-action] anthropic', r.status, data); res.status(502).json({ error: 'upstream' }); return; }
      const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      res.status(200).json({ reply: text || `I am not sure about that one. Give us a call${site.phone ? ' on ' + site.phone : ''} and we will help.` });
    } catch (e) {
      console.error('[site-action] ask', e);
      res.status(500).json({ error: 'server' });
    }
    return;
  }

  res.status(400).json({ error: 'unknown_action' });
}
