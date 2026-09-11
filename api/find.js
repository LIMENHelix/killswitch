import { classify, segment } from '../lib/web-presence.js';
import { identify, isOwner } from '../lib/roles.js';
import { placesSearch, parseAddr } from '../lib/discovery.js';

// Killswitch Websites lead finder — server-side Google Places (New) search.
// GOOGLE_PLACES_API_KEY is a Sensitive Vercel var (can't be pulled locally), so
// the search runs here where the key lives and returns no-website business leads
// as JSON. Called by _outreach/pull.py and the /master finder panel. Gated by
// SWITCH_TOKEN or an owner key. Unlinked and stateless: this endpoint renders
// leads for a human and persists nothing (autonomous persistence lives in
// lib/discovery.js / api/cron-discovery.js, never here).

const TRADES = {
  plumber: 'plumbers', electrician: 'electricians', hvac: 'hvac companies',
  roofer: 'roofers', landscaper: 'landscapers', painter: 'painters',
  'salon/barber': 'hair salons', 'nails/beauty': 'nail salons',
  dentist: 'dentists', 'clinic/doctor': 'medical clinics',
  'auto repair': 'auto repair shops', restaurant: 'restaurants',
  'cafe/coffee': 'coffee shops', vet: 'veterinary clinics',
  cleaning: 'cleaning services', 'pet groomer': 'pet grooming',
  florist: 'florists', bakery: 'bakeries', 'gym/fitness': 'gyms',
};
// The field mask (and its cost warning) now lives next to the search itself in
// lib/discovery.js, shared with the autonomous loop so the two paths cannot
// drift apart on what a Places call asks for (or bills).

// Places gives "Monday: 8:00 AM – 6:00 PM". The site template wants {d,h}, and
// consecutive identical days collapse into one line the way a real sign reads.
function parseHours(oh) {
  const desc = (oh && oh.weekdayDescriptions) || [];
  const rows = [];
  for (const line of desc) {
    const i = String(line).indexOf(':');
    if (i < 1) continue;
    const d = line.slice(0, i).trim();
    const h = line.slice(i + 1).trim();
    if (!d || !h) continue;
    const last = rows[rows.length - 1];
    if (last && last.h === h) last.days.push(d);
    else rows.push({ days: [d], h });
  }
  return rows.map((r) => ({
    d: r.days.length > 1 ? `${r.days[0]} to ${r.days[r.days.length - 1]}` : r.days[0],
    h: r.h,
  })).slice(0, 7);
}

// lib/discovery.js owns the request itself, including the server-side timeout
// this handler lacked before (a hanging Places call could hold a serverless
// invocation open indefinitely).

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }
  const token = process.env.SWITCH_TOKEN;
  if (!token) { res.status(503).json({ error: 'not_configured' }); return; }
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) { res.status(503).json({ error: 'no_places_key' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  // SWITCH_TOKEN (how _outreach/pull.py has always called this) OR an owner key,
  // so the finder can be run from /master with the key already in the browser
  // instead of requiring a token nobody can read out of Vercel.
  const presented = body.token || req.headers['x-switch-token'];
  if (presented !== token && !isOwner(identify(presented))) { res.status(401).json({ error: 'unauthorized' }); return; }

  const trade = String(body.trade || '').trim();
  const city = String(body.city || '').trim();
  const noun = TRADES[trade];
  if (!noun || !city) { res.status(400).json({ error: 'need a valid trade + city' }); return; }
  const query = `${noun} in ${city}`;

  try {
    const leads = [], seen = new Set();
    const skipped = { closed: 0, hasSite: 0, chain: 0 };
    const droppedHosts = {};
    const seenHost = new Set();
    let pageToken = null, pages = 0;
    do {
      const d = await placesSearch({ query, key, pageToken });
      for (const p of d.places || []) {
        // Permanently closed shops used to be excluded by hand, one at a time.
        if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') { skipped.closed++; continue; }

        // A placeholder is a BETTER lead than nothing, not a disqualification.
        const web = classify(p.websiteUri);
        if (!web.isTarget) {
          skipped.hasSite++;
          // Tally WHAT we dropped, not just how many. Counts alone cannot tell
          // "they genuinely own a domain" from "they are on a platform missing
          // from lib/web-presence.js", and those call for opposite conclusions.
          if (web.host) droppedHosts[web.host] = (droppedHosts[web.host] || 0) + 1;
          continue;
        }

        const name = ((p.displayName || {}).text || '').trim();
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());

        // A chain is one business with many pins, not many leads. Burnett Auto
        // came back five times and Firestone four; counting each location
        // separately overstates both the pool and how much of it we discard.
        const h = web.host;
        if (h) {
          if (seenHost.has(h)) { skipped.chain++; continue; }
          seenHost.add(h);
        }

        leads.push({
          placeId: p.id || '',           // canonical identity, so seeded rows can be deduped later
          trade, name,
          phone: p.nationalPhoneNumber || '',
          ...parseAddr(p.addressComponents),
          web_status: web.status,          // none | facebook_only | directory_only | diy_builder
          web_url: web.url,
          web_label: web.label,
          category: (p.primaryTypeDisplayName || {}).text || '',
          rating: p.rating || 0,
          reviews_count: p.userRatingCount || 0,
          // A label, not a ranking. Which of these actually converts is an open
          // question the call board will answer; see lib/web-presence.js.
          segment: segment(p.rating, p.userRatingCount),
          hours: parseHours(p.regularOpeningHours),
          // Google's words about them, never the owner's. Kept separate so it
          // lands in the review bucket rather than straight onto their site.
          google_summary: (p.editorialSummary || {}).text || '',
        });
      }
      pageToken = d.nextPageToken; pages++;
      if (pageToken && pages < 2) { await new Promise((r) => setTimeout(r, 2100)); } else { pageToken = null; }
    } while (pageToken);
    const byStatus = {};
    for (const l of leads) byStatus[l.web_status] = (byStatus[l.web_status] || 0) + 1;
    const withHours = leads.filter((l) => l.hours && l.hours.length).length;
    const withRating = leads.filter((l) => l.rating >= 4 && l.reviews_count >= 15).length;
    // One line to the runtime log, so a run can be read back without the caller
    // having to paste anything anywhere.
    // Repeat hosts are the tell: one shared domain across several businesses is a
    // platform we should be classifying, not thirty separate independent sites.
    const dropped = Object.entries(droppedHosts).sort((a, b) => b[1] - a[1]).slice(0, 15);
    const shared = dropped.filter(([, n]) => n > 1);
    console.log('[find]', JSON.stringify({
      query, kept: leads.length, byStatus, skipped, withHours, withRating,
      dropped, sharedHosts: shared.length,
    }));
    res.status(200).json({
      ok: true, query, count: leads.length, byStatus, skipped, withHours, withRating,
      dropped, leads,
    });
  } catch (e) {
    console.error('[find]', e);
    res.status(502).json({ error: String(e.message || e) });
  }
}
