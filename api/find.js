import { classify } from '../lib/web-presence.js';
import { identify, isOwner } from '../lib/roles.js';

// Killswitch Websites lead finder — server-side Google Places (New) search.
// GOOGLE_PLACES_API_KEY is a Sensitive Vercel var (can't be pulled locally), so
// the search runs here where the key lives and returns no-website business leads
// as JSON. Called by _outreach/pull.py. Gated by SWITCH_TOKEN. Unlinked.

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
// We were paying for a Places call and asking for six fields. The same call
// carries what makes a generated site worth looking at: their real hours, their
// category, whether they are still trading, and the reputation numbers that make
// the opening line of a call true. `reviews` and `photos` are deliberately left
// out: they are the most expensive fields and we do not republish third-party
// review text on a business's own site.
//
// ⚠ COST: the field mask decides which Places SKU the request bills at. rating
// and userRatingCount move it off the cheapest tier. Watch the first bill after
// deploying this rather than assuming the old per-request cost still holds.
const FIELDMASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.addressComponents',
  'places.nationalPhoneNumber', 'places.websiteUri',
  'places.businessStatus',            // drops permanently-closed shops automatically
  'places.regularOpeningHours',       // the business publishes these itself
  'places.primaryTypeDisplayName',    // what they actually are, in Google's words
  'places.editorialSummary',          // Google's description, NOT the owner's
  'places.rating', 'places.userRatingCount',
  'nextPageToken',
].join(',');

function parseAddr(components) {
  const g = {};
  for (const c of components || []) {
    const t = c.types || [];
    if (t.includes('street_number')) g.num = c.longText || '';
    else if (t.includes('route')) g.route = c.longText || '';
    else if (t.includes('locality')) g.city = c.longText || '';
    else if (t.includes('postal_town') && !g.city) g.city = c.longText || '';
    else if (t.includes('administrative_area_level_1')) g.state = c.shortText || '';
    else if (t.includes('postal_code')) g.zip = c.longText || '';
  }
  return {
    street: [g.num, g.route].filter(Boolean).join(' ').trim(),
    city: g.city || '', state: g.state || '', zip: g.zip || '',
  };
}

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

async function search(query, key, pageToken) {
  const body = { textQuery: query, pageSize: 20 };
  if (pageToken) body.pageToken = pageToken;
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDMASK },
    body: JSON.stringify(body),
  });
  if (!r.ok) { throw new Error('places ' + r.status + ': ' + (await r.text()).slice(0, 200)); }
  return r.json();
}

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
    const skipped = { closed: 0, hasSite: 0 };
    let pageToken = null, pages = 0;
    do {
      const d = await search(query, key, pageToken);
      for (const p of d.places || []) {
        // Permanently closed shops used to be excluded by hand, one at a time.
        if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') { skipped.closed++; continue; }

        // A placeholder is a BETTER lead than nothing, not a disqualification.
        const web = classify(p.websiteUri);
        if (!web.isTarget) { skipped.hasSite++; continue; }

        const name = ((p.displayName || {}).text || '').trim();
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());

        leads.push({
          trade, name,
          phone: p.nationalPhoneNumber || '',
          ...parseAddr(p.addressComponents),
          web_status: web.status,          // none | facebook_only | directory_only | diy_builder
          web_url: web.url,
          web_label: web.label,
          category: (p.primaryTypeDisplayName || {}).text || '',
          rating: p.rating || 0,
          reviews_count: p.userRatingCount || 0,
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
    console.log('[find]', JSON.stringify({
      query, kept: leads.length, byStatus, skipped, withHours, withRating,
    }));
    res.status(200).json({ ok: true, query, count: leads.length, byStatus, skipped, withHours, withRating, leads });
  } catch (e) {
    console.error('[find]', e);
    res.status(502).json({ error: String(e.message || e) });
  }
}
