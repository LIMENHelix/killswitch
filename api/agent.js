// Tools for the Grok voice agent on 913-933-1687.
//
// ONE agent, several jobs. The routing happens inside its head using these
// lookups, not by transferring the caller between bots: an AI-to-AI SIP REFER
// starts a fresh session, so the customer would have to explain themselves twice.
// The only transfer worth making is to a human, and the agent does that with
// xAI's own /refer against KS_HUMAN_PHONE.
//
// POST /api/agent  { action, token, ... }
//   whoami        {phone}                  who is calling, before it speaks
//   find_business {name, city?}            match a lead or site by name
//   publish_site  {slug, phone?}           put their site live and return the URL
//   create_lead   {name, trade, city, phone, notes}
//   log_call      {leadId|phone, notes, stage?}
//   book_call     {}                       the Calendly link, to read out
//   handoff       {}                       the human's number for a transfer
//
// GATED BY ITS OWN TOKEN (AGENT_TOKEN). This key gets pasted into a third-party
// console, so it must be revocable without touching ADMIN_KEY or a rep key. It
// can read a caller's own record, create leads, and publish a site. It CANNOT
// touch billing, postage, or another customer's data.
import { getLeads, saveLeads, getLeadMeta, setLeadMeta, getAccount } from '../lib/store.js';
import { getSite, upsertSite, listSites, slugify } from '../lib/sites.js';
import { notifyOperator } from '../lib/notify.js';
import { entitlements, CHANGE_PHASES } from '../lib/entitle.js';
import { onboardCustomer } from '../lib/onboard.js';

const CALENDLY = 'https://calendly.com/chrishubbel72/30min';

/** Last 10 digits, so 913-933-1687, (913) 933-1687 and +19139331687 all match. */
function digits(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}
const clean = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);

export default async function handler(req, res) {
  const expected = process.env.AGENT_TOKEN;
  if (!expected) { res.status(503).json({ error: 'no_auth_configured' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // THREE places the token may arrive, because no-code tool builders differ in
  // what they let you set. A header is cleanest, but if the console only offers a
  // URL and a body schema, ?token= works and so does a token field in the body.
  // Getting this wrong is invisible from the caller's side: the tool 401s, the
  // agent has nothing to work with, and it improvises or transfers.
  const q = (req.query && req.query.token) || '';
  const token = body.token || req.headers['x-agent-token'] || q;
  if (token !== expected) { res.status(401).json({ error: 'unauthorized' }); return; }

  // GET /api/agent?token=...&action=ping  — paste in a browser to prove the URL
  // and the token are right BEFORE wiring it into the agent.
  if (req.method === 'GET') {
    res.status(200).json({
      ok: true, pong: true,
      message: 'Token accepted. This URL is correct. Use POST with {"action":"whoami","phone":"..."} from the agent.',
      actions: ['whoami', 'find_business', 'publish_site', 'create_lead', 'log_call', 'book_call', 'handoff'],
    });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const host = (req.headers && req.headers.host) ? 'https://' + req.headers.host : 'https://killswitchwebsites.com';

  try {
    switch (body.action) {
      case 'whoami': return await whoami(res, body, host);
      case 'find_business': return await findBusiness(res, body);
      case 'publish_site': return await publish(res, body, host);
      case 'update_site': return await updateSite(res, body, host);
      case 'deliver_site': return await deliverSite(res, body, host);
      case 'create_lead': return await createLead(res, body, host);
      case 'log_call': return await logCall(res, body);
      case 'book_call':
        res.status(200).json({ ok: true, url: CALENDLY, say: 'I can book you a fifteen minute call. I will send the link, or I can read it out.' });
        return;
      case 'handoff':
        res.status(200).json({
          ok: true, phone: process.env.KS_HUMAN_PHONE || '',
          sip: process.env.KS_HUMAN_PHONE ? 'sip:' + digits(process.env.KS_HUMAN_PHONE) + '@sip.voice.x.ai' : '',
          say: 'Let me put you through to a person.',
        });
        return;
      default:
        res.status(400).json({ error: 'unknown_action' });
    }
  } catch (e) {
    console.error('[agent]', body.action, e);
    // Never hand the agent a stack trace to read aloud.
    res.status(500).json({ error: 'server_error', say: 'Something went wrong on my end. Let me get a person for you.' });
  }
}

/**
 * Who is on the phone, answered before the agent says anything.
 * Three outcomes drive the whole call: an existing CUSTOMER, someone we already
 * built a site for (postcard), or a stranger.
 */
async function whoami(res, body, host) {
  const d = digits(body.phone);
  if (!d) { res.status(200).json({ ok: true, kind: 'unknown' }); return; }

  const [leads, meta, sites] = await Promise.all([getLeads(), getLeadMeta(), listSites()]);
  const lead = leads.find((l) => digits(l.phone) === d) || null;
  const lm = lead ? (meta[lead.id] || {}) : {};

  // A site we built for them, either from their lead or matched on the number.
  let site = null;
  if (lm.siteSlug) site = await getSite(lm.siteSlug);
  if (!site) {
    const hit = sites.find((s) => s.leadId && lead && s.leadId === lead.id);
    if (hit) site = await getSite(hit.slug);
  }

  // Are they already a paying customer? Only if the site carries their email.
  let customer = null;
  if (site && site.email) {
    const account = await getAccount(site.email);
    if (account) {
      const { phases } = await entitlements(account, host);
      customer = {
        name: account.name || '',
        email: account.email,
        modulesOn: [...phases],
        canRequestChanges: CHANGE_PHASES.some((p) => phases.has(p)),
      };
    }
  }

  res.status(200).json({
    ok: true,
    kind: customer ? 'customer' : (site ? 'has_site_built' : (lead ? 'known_lead' : 'unknown')),
    business: (site && site.business) || (lead && lead.name) || '',
    city: (site && site.city) || (lead && lead.city) || '',
    trade: (site && site.trade) || (lead && lead.trade) || '',
    leadId: lead ? lead.id : '',
    site: site ? { slug: site.slug, url: host + '/s/' + site.slug, published: !!site.published, claimed: !!site.claimed } : null,
    customer,
    mailed: lead ? (lead.status === 'mailed') : false,
  });
}

/** They called from a different phone, so find them by name. */
async function findBusiness(res, body) {
  const q = clean(body.name, 80).toLowerCase();
  if (q.length < 3) { res.status(400).json({ error: 'name_too_short' }); return; }
  const city = clean(body.city, 60).toLowerCase();

  const sites = await listSites();
  let hits = sites.filter((s) => String(s.business || '').toLowerCase().includes(q));
  if (city && hits.length > 1) {
    const byCity = hits.filter((s) => String(s.city || '').toLowerCase().includes(city));
    if (byCity.length) hits = byCity;
  }
  res.status(200).json({
    ok: true, count: hits.length,
    matches: hits.slice(0, 5).map((s) => ({ slug: s.slug, business: s.business, city: s.city, published: !!s.published })),
  });
}

/**
 * The delivery moment. Publishes an already-built draft so the caller can open
 * it while still on the phone. Published but NOT claimed, so it stays noindex
 * until they actually sign up. Content is never changed here.
 */
async function publish(res, body, host) {
  const slug = slugify(body.slug);
  const site = slug ? await getSite(slug) : null;
  if (!site) { res.status(404).json({ error: 'no_site', say: 'I cannot find a site under that name.' }); return; }

  const already = !!site.published;
  if (!already) await upsertSite({ slug, published: true });

  const url = host + '/s/' + slug;
  const d = digits(body.phone);
  if (d) {
    const leads = await getLeads();
    const lead = leads.find((l) => digits(l.phone) === d);
    if (lead) await setLeadMeta(lead.id, { siteSlug: slug, sitePublished: true, publishedBy: 'voice agent', stage: 'responded' });
  }

  await notifyOperator({
    subject: `Voice agent published ${site.business}`,
    heading: 'A caller asked for their site and it went live',
    lines: [`Business: ${site.business}`, `Site: ${url}`, body.phone ? `Called from: ${body.phone}` : '', 'Published by the voice agent on 913-933-1687.'].filter(Boolean),
    url: host + '/master', urlText: 'Open Master Panel',
  });

  res.status(200).json({
    ok: true, url, alreadyLive: already,
    say: `Their site is live at ${url.replace('https://', '')}`,
  });
}

// What the owner is allowed to correct about their own business, by voice.
const SAY_FIELDS = ['tagline', 'about', 'phone', 'email_public', 'street', 'city', 'state', 'zip', 'bookingUrl', 'payUrl'];

function normHours(v) {
  if (!Array.isArray(v)) return null;
  return v.map((h) => ({ d: clean(h && h.d, 40), h: clean(h && h.h, 40) })).filter((h) => h.d && h.h).slice(0, 7);
}
function normServices(v) {
  if (!Array.isArray(v)) return null;
  return v.map((s) => (typeof s === 'string' ? { name: clean(s, 60), desc: '' } : { name: clean(s && s.name, 60), desc: clean(s && s.desc, 140) }))
    .filter((s) => s.name).slice(0, 12);
}

/**
 * Write facts onto a site while the owner is on the phone.
 *
 * TWO BUCKETS, DELIBERATELY. `confirmed` is what the caller themselves said, so
 * it goes straight onto the live record: it is their business and they are the
 * authority on it. `proposed` is anything a web search produced, and it does NOT
 * touch the site. It waits in /master for a human, because publishing a guess
 * about somebody's opening hours is exactly the failure this whole system is
 * built to avoid.
 */
async function updateSite(res, body, host) {
  const slug = slugify(body.slug);
  const site = slug ? await getSite(slug) : null;
  if (!site) { res.status(404).json({ error: 'no_site', say: 'I cannot find a site under that name.' }); return; }

  const c = body.confirmed || {};
  const patch = {};
  for (const f of SAY_FIELDS) if (c[f] !== undefined) patch[f] = clean(c[f], f === 'about' ? 600 : 200);
  const hrs = normHours(c.hours); if (hrs) patch.hours = hrs;
  const svc = normServices(c.services); if (svc) patch.services = svc;
  if (c.business) patch.business = clean(c.business, 80);

  // A proposal never overwrites anything. It accumulates and waits.
  const p = body.proposed || {};
  const proposed = { ...(site.proposed || {}) };
  for (const [k, v] of Object.entries(p)) {
    if (!SAY_FIELDS.includes(k) && !['hours', 'services', 'business'].includes(k)) continue;
    proposed[k] = (k === 'hours') ? (normHours(v) || []) : (k === 'services') ? (normServices(v) || []) : clean(v, 600);
  }
  const gotProposal = Object.keys(p).length > 0;
  if (gotProposal) {
    patch.proposed = proposed;
    patch.proposedNote = clean(body.proposedNote || 'found by the voice agent, not confirmed by the owner', 200);
  }

  if (!Object.keys(patch).length) { res.status(400).json({ error: 'nothing_to_update' }); return; }
  const saved = await upsertSite({ slug, ...patch });

  const confirmedFields = Object.keys(patch).filter((k) => k !== 'proposed' && k !== 'proposedNote');
  if (gotProposal) {
    await notifyOperator({
      subject: `Needs your eye: suggested details for ${site.business}`,
      heading: 'The voice agent found details it could not confirm',
      lines: [`Business: ${site.business}`, `Site: ${host}/s/${slug}`,
        `Waiting for approval: ${Object.keys(proposed).join(', ')}`,
        'Nothing has been published. Approve or discard it in Master.'],
      url: host + '/master', urlText: 'Review in Master Panel',
    });
  }

  res.status(200).json({
    ok: true, url: host + '/s/' + slug,
    updated: confirmedFields, awaitingApproval: Object.keys(proposed),
    live: !!saved.published,
    say: confirmedFields.length ? 'Their site is updated.' : 'Noted for review.',
  });
}

/**
 * The end of the best call there is: they said yes, so take their email, put the
 * site live, mark it theirs, and let the existing onboarding path email them the
 * link and their control panel. This is the moment a phone call becomes a
 * customer with nobody touching a keyboard.
 *
 * Claiming makes the site indexable, which is a consent threshold, so it only
 * happens here, where a human has said yes out loud and given an address to send
 * it to. The agent is told to read the email back before calling this.
 */
async function deliverSite(res, body, host) {
  const slug = slugify(body.slug);
  const email = clean(body.email, 160).toLowerCase();
  if (!email || email.indexOf('@') < 1 || email.indexOf('.') < 0) {
    res.status(400).json({ error: 'bad_email', say: 'That email did not sound right. Could you say it again?' });
    return;
  }
  const site = slug ? await getSite(slug) : null;
  if (!site) { res.status(404).json({ error: 'no_site' }); return; }

  const saved = await upsertSite({ slug, email, published: true, claimed: true });
  const out = await onboardCustomer({
    email, site: saved.business, name: clean(body.name, 80), host, source: 'voice-agent',
  });
  if (out.error) { res.status(400).json({ error: out.error }); return; }

  if (body.phone) {
    const d = digits(body.phone);
    const leads = await getLeads();
    const lead = leads.find((l) => digits(l.phone) === d);
    if (lead) await setLeadMeta(lead.id, { siteSlug: slug, sitePublished: true, stage: 'won', notes: 'delivered by the voice agent to ' + email });
  }

  await notifyOperator({
    subject: `WON - ${saved.business} took their site on the phone`,
    heading: 'The voice agent closed one',
    lines: [`Business: ${saved.business}`, `Email: ${email}`, `Site: ${host}/s/${slug}`,
      out.emailed ? 'Their receipt and panel link were emailed.' : 'WARNING: the email did not send, so they have nothing yet.'],
    url: host + '/master', urlText: 'Open Master Panel',
  });

  res.status(200).json({
    ok: true, url: host + '/s/' + slug, emailed: !!out.emailed,
    say: out.emailed
      ? `Sent. It is on its way to ${email}, and their site is live.`
      : 'Their site is live, but the email did not go out. Read them the address.',
  });
}

/** A stranger who wants one. Capture, do not promise a build time. */
async function createLead(res, body, host) {
  const name = clean(body.name, 80);
  if (!name) { res.status(400).json({ error: 'name_required' }); return; }
  const phone = clean(body.phone, 40);

  const leads = await getLeads();
  const d = digits(phone);
  const existing = d ? leads.find((l) => digits(l.phone) === d) : null;
  if (existing) {
    await setLeadMeta(existing.id, { notes: clean(body.notes, 400), stage: 'responded' });
    res.status(200).json({ ok: true, id: existing.id, duplicate: true });
    return;
  }

  const id = 'v' + Date.now().toString(36);
  leads.push({
    id, name, trade: clean(body.trade, 40), phone,
    street: clean(body.street, 120), city: clean(body.city, 60),
    state: clean(body.state, 20), zip: clean(body.zip, 12),
    email: '', status: 'inbound_call',
  });
  await saveLeads(leads);
  await setLeadMeta(id, { stage: 'responded', owner: 'voice agent', notes: clean(body.notes, 400) });

  await notifyOperator({
    subject: `New caller wants a free site - ${name}`,
    heading: 'The voice agent took a new lead',
    lines: [`Business: ${name}`, phone ? `Phone: ${phone}` : '', clean(body.trade, 40) ? `Trade: ${clean(body.trade, 40)}` : '',
      [clean(body.city, 60), clean(body.state, 20)].filter(Boolean).join(', '), body.notes ? `Notes: ${clean(body.notes, 400)}` : ''].filter(Boolean),
    url: host + '/admin', urlText: 'Open the call list',
  });

  res.status(200).json({ ok: true, id, say: 'Got it, I have their details.' });
}

/** Whatever happened on the call, written where the humans will see it. */
async function logCall(res, body) {
  let id = clean(body.leadId, 40);
  if (!id && body.phone) {
    const d = digits(body.phone);
    const leads = await getLeads();
    const l = leads.find((x) => digits(x.phone) === d);
    id = l ? l.id : '';
  }
  if (!id) { res.status(404).json({ error: 'no_lead' }); return; }
  const patch = { notes: clean(body.notes, 400) };
  if (['called', 'responded', 'won', 'dead'].includes(body.stage)) patch.stage = body.stage;
  const saved = await setLeadMeta(id, patch);
  res.status(200).json({ ok: true, meta: saved });
}
