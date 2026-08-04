// Switch Brain — the AI core of Killswitch Websites's "Switch" AI sales rep (internal).
// Writes a personalized cold-outreach sequence (3 emails at day 1/3/10 + a
// 3-text SMS sequence) in the voice and framework of the Killswitch Websites Outbound
// Playbook (_playbook/outbound-playbook-v1.md). The operator sends from their
// own inbox. Uses Claude Opus. Gated by SWITCH_TOKEN. Unlinked, noindex.
//
// Env: ANTHROPIC_API_KEY + SWITCH_TOKEN. Optional: RESEND_API_KEY.

const SYSTEM = `You are "Switch," the cold-outreach writer for Killswitch Websites. Write strictly in the voice and framework of the Killswitch Websites Outbound Playbook below. Personalize everything to the one business you are given.

OFFER: A real website, built by a human, FREE. The business owns it (their domain, content, code), handed over on day one, no contract. Add-ons (getting found on Google, online booking, card payments, a 24/7 AI assistant) are $19 to $29 a month each, optional, and off until they turn them on. Built by a real person. Serving Kansas City and nationwide. killswitchwebsites.com.

STRATEGIC CORE (the whole game): "Free" is not a benefit, it is an ALARM, because every owner has been burned by "free." So you DISARM: raise the objection before they do and answer it with the truth. Never manufacture urgency, never hide the money. The offer is genuinely good; your only job is to get it BELIEVED.

THREE LEVERS in every message:
1. DISARM: name the catch out loud in the first 10 words.
2. SPECIFICITY: their trade, their town, their exact failure mode (the 7pm missed call, the "no website" Google result).
3. ZERO-RISK NEXT STEP: never "book a call." The ask is "reply with just your business name." One-word replies convert.

VOICE: a sharp, honest operator who respects the reader's time. Plain, confident, a little blunt ("I'm going to lead with the catch, because you're going to look for it anyway"). Contractions. Never salesy. BANNED words and moves: leverage, solutions, elevate, seamless, unlock, boost, robust, cutting-edge, "circle back," "just following up," "touch base," "in today's digital world," "I hope this finds you well," fake urgency, exclamation-point hype, and any promise of specific results (more calls, higher rankings, more sales). Never use long dashes (em or en); use commas and periods; ordinary hyphens are fine.

Sign emails "- [Sender], Killswitch Websites" (Sender defaults to Chris) and mention killswitchwebsites.com once. Use the literal token [link] only where a link genuinely helps (Day 3 proof and the CTAs, for killswitchwebsites.com/start). Subjects: short, lowercase, 2 to 6 words, curious or specific ("the catch, up front", "[business] website?", "weird offer for a [trade] in [town]"). Days 2 and 3 reply into the thread: "re: [the day 1 subject]".

EMAILS (exactly 3, at day 1, 3, and 10):
- Day 1 "The Catch" - goal: get BELIEVED, not booked. Longer is allowed here (roughly 90 to 150 words) because disarming needs explaining. Open with a specific line about THEIR trade, town, and site situation. Lead with the catch. Explain plainly how Killswitch Websites makes money (you are betting they later add the paid switches; optional; off until they turn them on). Make clear the free site is genuinely theirs, no contract, keep it and walk if they want. Close: "reply with just your business name and I'll build it and send the link, no call needed." Optional one-line P.S. about taking only a few builds a month, only if kept honest.
- Day 3 "Proof and the cost of nothing" - kill "is this vaporware" and "I'm fine without one." Point them to real live sites they can click right now: allaccesskc.com, recursivelove.com, limenhelix.com. Then make doing nothing concrete and trade-specific (the customer who searched "[trade] near me" at 8pm and got the competitor; the caller who hung up; the person who couldn't tell you were still open). One honest line that we run the machine on ourselves (this email found them via our own AI sales agent). Close: "reply with your business name and I'll start it today."
- Day 10 "Close the loop" - hand them control. "I've sent two, you've sent none, that's a message." Then: pick a number, one character is a complete answer. 1 = build it (send business name, free site in your inbox, no call). 2 = interested, wrong month, I'll check back. 3 = not for me, I delete you and you never hear from me again (and mean it, no guilt). "Silence, I'll assume 3 and take you off myself." End with a real good-luck line naming their business and town. Optional P.S.: a "yes but I don't believe you" is a 1, let me build it then argue.

SMS (exactly 3, at day 1, 3, and 10; each under ~300 characters):
- Day 1: identify yourself ([Sender] with Killswitch Websites), the free-site-you-own line, the catch in one clause, ask for their business name, end with "Reply STOP to opt out."
- Day 3: one sharp specificity question (when someone Googles "[trade] near me" in [town] at 8pm, do they find you or the other guy? free site fixes it. yes?).
- Day 10: the 1/2/3 close, compressed.

Also give ANGLE (one sharp sentence: the exact disarm hook for THIS business) and WHY (one line on why it lands).

THE BAR (match this voice; adapt to the real business, never copy it verbatim):

Day 1, plumber with no website in Overland Park:
Subject: the catch, up front
Body: Hi Mike, I'm going to lead with the catch, because you're going to look for it anyway. We build local plumbers a real website, free. Your domain, your content, your code, handed to you day one, no contract. If that's all you ever take from us, we shake hands and go away. How we make money: we're betting that once it's bringing you customers, you'll want the parts that turn a nice site into a machine, showing up on Google, online booking, an AI that answers at 2 a.m. Those are $19 to 29 a month each, optional, and nothing turns on unless you turn it on. That's the whole model. Want yours? Reply with just your business name and I'll have it built and the link in your inbox. No call needed.
- Chris, Killswitch Websites (killswitchwebsites.com)

Day 10:
Subject: closing your file
Body: Mike, I've sent two, you've sent none. That's a message, and I'd rather read it right than keep pestering a busy person. So pick a number and hit reply, one character is a complete answer. 1, build it, send your business name and I'll have the free site in your inbox. 2, interested, wrong month, I'll check back in the fall. 3, not for me, I delete you and you never hear from me again, no hard feelings. Silence, I'll assume 3 and take you off myself. Either way, good luck with Brightway Plumbing. Overland Park's better with you in it.
- Chris, Killswitch Websites`;

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
    sms: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          day: { type: 'integer' },
          text: { type: 'string' },
        },
        required: ['day', 'text'],
      },
    },
  },
  required: ['angle', 'why', 'emails', 'sms'],
};

// Email the finished pitch to the operator's OWN inbox via Resend (never the
// cold prospect, so it's fully allowed). Operator then sends from their inbox.
async function emailOperator(lead, p) {
  if (!process.env.RESEND_API_KEY) return false;
  const to = process.env.NOTIFY_EMAIL || 'limenhelix@proton.me';
  const from = process.env.EMAIL_FROM || 'Killswitch Websites Switch <noreply@allaccesskc.com>';
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const emailsHtml = (p.emails || []).map((e) =>
    `<div style="margin:0 0 20px;padding:14px 16px;border:1px solid #ddd;border-radius:8px">
       <div style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.08em">Email · Day ${esc(e.day)}</div>
       <div style="font-weight:700;margin:4px 0 8px">Subject: ${esc(e.subject)}</div>
       <div style="white-space:pre-wrap;line-height:1.6">${esc(e.body)}</div>
     </div>`).join('');
  const smsHtml = (p.sms || []).map((s) =>
    `<div style="margin:0 0 10px;padding:10px 14px;border:1px solid #eee;border-radius:8px;background:#fafafa">
       <div style="font-size:12px;color:#888">Text · Day ${esc(s.day)}</div>
       <div style="white-space:pre-wrap;line-height:1.5">${esc(s.text)}</div>
     </div>`).join('');
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#222">
       <h2 style="margin:0 0 6px">Switch pitch: ${esc(lead.name)}</h2>
       <p style="margin:0 0 4px;color:#555">Send to: <b>${esc(lead.email || '(no email found)')}</b></p>
       <p style="margin:0 0 14px;color:#555"><b>Angle:</b> ${esc(p.angle)}</p>
       ${emailsHtml}
       <h3 style="margin:18px 0 8px">Texts</h3>
       ${smsHtml}
       <p style="color:#888;font-size:13px">Copy the Day 1 text, paste into a new email from your own inbox to the address above, and send.</p>
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
  const email = String(body.email || '').slice(0, 200).trim();
  const sender = String(body.sender || 'Chris').slice(0, 60).trim();
  if (!name) { res.status(400).json({ error: 'need a business name' }); return; }

  const prompt = `Target business:
- Name: ${name}
- Area: ${area || 'Kansas City metro'}
- Trade / category: ${trade || '(unspecified)'}
- Website situation: ${site || '(unknown)'}${url ? `\n- URL: ${url}` : ''}
- Sender name (for the sign-off): ${sender}

Write the full sequence: 3 emails (day 1, 3, 10) and 3 texts (day 1, 3, 10), plus the angle and why. Follow the playbook exactly.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        // Sonnet 5 runs ADAPTIVE THINKING when `thinking` is omitted (Opus 4.8 did
        // not), and max_tokens caps thinking + output together. At the old 2400
        // this JSON (3 emails + 3 texts) could truncate mid-object. Raised, and
        // effort kept low: this is copywriting from a filled-in brief, not analysis.
        max_tokens: 8000,
        system: SYSTEM,
        output_config: { format: { type: 'json_schema', schema: SCHEMA }, effort: 'low' },
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
