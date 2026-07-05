// Switch Brain — the AI core of Killswitch's "Switch" AI sales rep (internal/demo).
// Given a target local business, Claude finds the sharpest outreach ANGLE and
// writes a personalized 3-email cold sequence to book a call.
//
// This is the "moat" piece — the intelligence that justifies $1,000/mo over a
// $37 mail-merge. Uses Claude Opus (quality matters; volume is low). Gated by
// SWITCH_TOKEN so it can't be found and abused into a cost bleed. Unlinked.
//
// Env required: ANTHROPIC_API_KEY (already set) + SWITCH_TOKEN (the gate).

const SYSTEM = `You are "Switch," an elite AI sales-development rep for Killswitch — a Kansas City studio that builds custom websites and software (sharp sites from $149, often live within ~30 minutes of a quick call, fully done-for-you, the client owns everything).

Your job: given a target local business, find the single sharpest ANGLE to reach out about, then write a 3-email cold-outreach sequence that books a quick call. You are pitching Killswitch's website/build service to this business.

RULES:
- Be specific to THIS business — work in their trade, their area, and their exact website situation. Absolutely no generic mail-merge feel.
- Voice: short, human, confident, lightly warm — the way a sharp local guy actually emails, not a corporate template. 2-4 sentences per email, max.
- Lead with value and curiosity, never a hard sell. The hook is a FREE mockup (Killswitch can build a one-page site in ~30 minutes, so offering to show them what theirs could look like is the killer move).
- Email 1 = the opener (the angle + the free-mockup offer). Email 2 = day 3, replies to the same thread, nudges the free mockup. Email 3 = day 6, a short no-pressure last touch with a call link.
- Be honest. Don't invent facts about the business beyond what you're told. Never promise specific business results.
- Sign each email as "Chris · Killswitch" and reference killswitch.domains. Put a [Calendly] placeholder where a booking link belongs.

Also give the ANGLE (one sharp sentence: the hook you'd lead with) and a one-line WHY (why this approach lands for this business).`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    angle: { type: 'string' },
    why: { type: 'string' },
    emails: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          day: { type: 'integer' },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['day', 'subject', 'body'],
      },
    },
  },
  required: ['angle', 'why', 'emails'],
};

// Email the finished pitch to the operator's own inbox via Resend (the same
// service AllAccessKC uses). This sends ONLY to the operator — never to the
// cold prospect — so it's fully allowed. Operator then copy-pastes + sends.
async function emailOperator(lead, p) {
  if (!process.env.RESEND_API_KEY) return false;
  const to = process.env.NOTIFY_EMAIL || 'limenhelix@proton.me';
  const from = process.env.EMAIL_FROM || 'Killswitch Switch <noreply@allaccesskc.com>';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const emailsHtml = (p.emails || []).map((e) =>
    `<div style="margin:0 0 20px;padding:14px 16px;border:1px solid #ddd;border-radius:8px">
       <div style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.08em">Day ${esc(e.day)}</div>
       <div style="font-weight:700;margin:4px 0 8px">Subject: ${esc(e.subject)}</div>
       <div style="white-space:pre-wrap;line-height:1.6">${esc(e.body)}</div>
     </div>`).join('');
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#222">
       <h2 style="margin:0 0 6px">Switch pitch: ${esc(lead.name)}</h2>
       <p style="margin:0 0 4px;color:#555">Send to: <b>${esc(lead.email || '(no email found)')}</b></p>
       <p style="margin:0 0 18px;color:#555"><b>Angle:</b> ${esc(p.angle)}</p>
       ${emailsHtml}
       <p style="color:#888;font-size:13px">Copy the Day 1 text → paste into a new email from your own inbox to the address above → send.</p>
     </div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, subject: `Switch pitch: ${lead.name}`, html }),
    });
    return r.ok;
  } catch (e) { console.error('[switch-brain] resend error', e); return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const token = process.env.SWITCH_TOKEN;
  if (!token) { res.status(503).json({ error: 'not_configured' }); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(503).json({ error: 'no_ai_key' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const provided = body.token || req.headers['x-switch-token'];
  if (provided !== token) { res.status(401).json({ error: 'unauthorized' }); return; }

  const name = String(body.name || '').slice(0, 120).trim();
  const area = String(body.area || '').slice(0, 120).trim();
  const trade = String(body.trade || '').slice(0, 120).trim();
  const site = String(body.site || '').slice(0, 200).trim();
  const url = String(body.url || '').slice(0, 200).trim();
  if (!name) { res.status(400).json({ error: 'need a business name' }); return; }

  const prompt = `Target business:
- Name: ${name}
- Area: ${area || 'Kansas City metro'}
- Trade / category: ${trade || '(unspecified)'}
- Website situation: ${site || '(unknown)'}${url ? `\n- URL: ${url}` : ''}

Find the angle and write the 3-email sequence.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 1600,
        system: SYSTEM,
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[switch-brain] anthropic error', r.status, data);
      res.status(502).json({ error: 'upstream', detail: (data && data.error) || null });
      return;
    }
    if (data.stop_reason === 'refusal') { res.status(200).json({ error: 'refused' }); return; }

    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    let parsed;
    try { parsed = JSON.parse(text); } catch { res.status(200).json({ error: 'parse', raw: text }); return; }

    const emailed = await emailOperator({ name, email }, parsed);
    res.status(200).json({ ok: true, emailed, ...parsed });
  } catch (e) {
    console.error('[switch-brain] error', e);
    res.status(500).json({ error: 'server' });
  }
}
