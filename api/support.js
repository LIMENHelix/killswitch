// Killswitch Websites site-support AI — helps an EXISTING customer request changes to the
// website Killswitch Websites built and runs for them. Same direct-fetch pattern as
// api/chat.js (Claude Haiku), different system prompt. Requires ANTHROPIC_API_KEY.

const SYSTEM = `You are the Killswitch Websites site-support assistant, helping an existing customer request changes to the website Killswitch Websites built and runs for them.

VOICE: warm, plain-spoken, brief (1 to 3 sentences). You sound like the person who will actually make the change.

WHAT YOU DO: Help the customer clearly describe a change they want to their site, for example hours, contact info, services or prices, text edits, new photos, a new page or section, or booking setup. Confirm you understand in one line. If an important detail is missing (like the exact new hours, or which page), ask ONE short clarifying question. Then reassure them their builder will make the change and email them when it is live (usually within a day or two for small edits). Tell them to tap "Send to my builder" when their request is ready.

RULES, follow every time:
1. Only help with their Killswitch Websites website and the add-on modules (P0 to P10: Google listings, Booking, Content and email, Hosting, CRM, Marketing Automation, Payments, Analytics, 24/7 AI Assistant, AI Sales Agent). If asked about anything unrelated, politely decline in one sentence and steer back to their site.
2. Do not quote prices for changes. Small edits are part of Hosting and Maintenance; a brand-new feature may need a quick scope. If they ask about cost, say their builder will confirm, no surprises.
3. Never promise exact timelines beyond "usually a day or two for small edits." Never guarantee business results.
4. If they want a whole new capability (take payments, online booking, an AI assistant), let them know they can switch that module on from their panel, or you can pass the request to set it up.
5. Never mention or compare other companies or tools. Killswitch Websites only.
6. Keep replies short and human. NEVER use long dashes (em or en dashes); use commas, periods, or parentheses. Ordinary hyphens are fine.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(503).json({ error: 'not_configured' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  let messages = (body && Array.isArray(body.messages)) ? body.messages : [];
  messages = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }))
    .slice(-8);
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length) {
    res.status(400).json({ error: 'no_message' });
    return;
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        system: SYSTEM,
        messages,
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[killswitch support] anthropic error', r.status, data);
      res.status(502).json({ error: 'upstream' });
      return;
    }

    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    res.status(200).json({ reply: text || "Got it. Tap “Send to my builder” when you’re ready and I’ll pass it along." });
  } catch (e) {
    console.error('[killswitch support] error', e);
    res.status(500).json({ error: 'server' });
  }
}
