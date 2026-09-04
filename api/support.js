// Site-support assistant for an EXISTING customer, and the change-request intake.
//
// GATED ON PURPOSE. The free site is a generic template the customer owns and
// keeps. Changing it by hand is labour, and labour is the product: Care Plan
// (P11) or Hosting & Maintenance (P4) buys it. This endpoint used to have no
// auth of any kind, so anyone on the internet could drive the Anthropic key, and
// every free customer could file unlimited work orders forever. Both are closed.
//
// POST /api/support  { e, t, action, ... }
//   action 'ask'    (default) { messages:[...] } -> { reply }
//   action 'submit' { requests:[...] }           -> { ok } and emails the operator
// A customer without a change plan gets 403 { error:'not_entitled' } and the
// panel turns that into the upgrade offer rather than a dead end.
import { getAccount } from '../lib/store.js';
import { verifyPanel } from '../lib/panel-auth.js';
import { entitlements, canRequestChanges, CHANGE_PHASES } from '../lib/entitle.js';
import { notifyOperator } from '../lib/notify.js';
import { limited, LIMITS } from '../lib/ratelimit.js';
import { recordUsage } from '../lib/ai-usage.js';
import { publicOrigin } from '../lib/origin.js';
import { externalSideEffectsAllowed } from '../lib/environment.js';

const SYSTEM = `You are the Killswitch Websites site-support assistant, helping an existing customer request changes to the website Killswitch Websites built and runs for them. They are on a plan that covers changes, so you never need to sell them anything.

VOICE: warm, plain-spoken, brief (1 to 3 sentences). You sound like the person who will actually make the change.

WHAT YOU DO: Help the customer clearly describe a change they want to their site, for example hours, contact info, services or prices, text edits, new photos, a new page or section, or booking setup. Confirm you understand in one line. If an important detail is missing (like the exact new hours, or which page), ask ONE short clarifying question. Then reassure them their builder will make the change and email them when it is live (usually within a day or two for small edits). Tell them to tap "Send to my builder" when their request is ready.

RULES, follow every time:
1. Only help with their Killswitch Websites website and the add-on modules (P0 to P11: Google listings, Booking, Content and email, Hosting, CRM, Marketing Automation, Payments, Analytics, 24/7 AI Assistant, AI Sales Agent, Care Plan). If asked about anything unrelated, politely decline in one sentence and steer back to their site.
2. Do not quote prices for changes. Their plan already covers changes to their existing site. A brand-new capability may need a quick scope. If they ask about cost, say their builder will confirm, no surprises.
3. Never promise exact timelines beyond "usually a day or two for small edits." Never guarantee business results.
4. If they want a whole new capability (take payments, online booking, an AI assistant), let them know they can switch that module on from their panel, or you can pass the request to set it up.
5. Never mention or compare other companies or tools. Killswitch Websites only.
6. Keep replies short and human. NEVER use long dashes (em or en dashes); use commas, periods, or parentheses. Ordinary hyphens are fine.`;

const clean = (v, n = 600) => String(v == null ? '' : v).trim().slice(0, n);

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  // ---- who is asking ----
  const email = String(body.e || '').trim().toLowerCase();
  const token = String(body.t || '');
  if (!await verifyPanel(email, token)) { res.status(401).json({ error: 'unauthorized' }); return; }

  let account;
  try { account = await getAccount(email); }
  catch (e) { console.error('[support] store', e); res.status(500).json({ error: 'store_error' }); return; }
  if (!account) { res.status(404).json({ error: 'not_found' }); return; }

  // ---- are they paying for hand edits ----
  const host = publicOrigin();
  let phases;
  try { ({ phases } = await entitlements(account, host)); }
  catch (e) { console.error('[support] entitlements', e); res.status(500).json({ error: 'server_error' }); return; }

  if (!canRequestChanges(phases)) {
    res.status(403).json({ error: 'not_entitled', need: CHANGE_PHASES });
    return;
  }

  // Panel auth is not a spend limit: one customer's leaked link should not
  // be able to run the Anthropic key flat.
  if (await limited(req, res, { bucket: 'support:' + email, ...LIMITS.support })) return;

  const action = body.action || 'ask';

  // ---- file the request with a real name on it ----
  // This used to post to Web3Forms straight from the browser WITHOUT the
  // customer's email, so a change request arrived with no way to tell who sent
  // it. It goes through the operator notifier now, identified.
  if (action === 'submit') {
    const requests = (Array.isArray(body.requests) ? body.requests : [])
      .map((r) => clean(r, 800)).filter(Boolean).slice(0, 12);
    if (!requests.length) { res.status(400).json({ error: 'no_request' }); return; }

    const who = account.name || account.site || email;
    const plan = CHANGE_PHASES.filter((p) => phases.has(p)).join(', ');
    const r = await notifyOperator({
      subject: `Site change request - ${who}`,
      heading: 'A customer asked for a change to their site',
      lines: [
        `Customer: ${who}`,
        `Email: ${email}`,
        account.site ? `Site: ${account.site}` : '',
        `Covered by: ${plan}`,
        '',
        ...requests.map((x, i) => `${i + 1}. ${x}`),
      ].filter((l) => l !== undefined),
      url: host + '/master', urlText: 'Open Master Panel',
    });
    res.status(200).json({ ok: true, delivered: !!r.sent });
    return;
  }

  // ---- the AI helper ----
  if (action !== 'ask') { res.status(400).json({ error: 'unknown_action' }); return; }
  if (!externalSideEffectsAllowed()) { res.status(503).json({ error: 'preview_side_effects_disabled' }); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(503).json({ error: 'not_configured' }); return; }

  let messages = (body && Array.isArray(body.messages)) ? body.messages : [];
  messages = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }))
    .slice(-8);
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length) { res.status(400).json({ error: 'no_message' }); return; }

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
    await recordUsage({ model: 'claude-haiku-4-5', usage: data.usage, where: 'P4-P11-support' });
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

    res.status(200).json({ reply: text || 'Got it. Tap "Send to my builder" when you are ready and I will pass it along.' });
  } catch (e) {
    console.error('[killswitch support] error', e);
    res.status(500).json({ error: 'server' });
  }
}
