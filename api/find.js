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
const FIELDMASK = 'places.displayName,places.addressComponents,places.nationalPhoneNumber,places.websiteUri,nextPageToken';

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
  if ((body.token || req.headers['x-switch-token']) !== token) { res.status(401).json({ error: 'unauthorized' }); return; }

  const trade = String(body.trade || '').trim();
  const city = String(body.city || '').trim();
  const noun = TRADES[trade];
  if (!noun || !city) { res.status(400).json({ error: 'need a valid trade + city' }); return; }
  const query = `${noun} in ${city}`;

  try {
    const leads = [], seen = new Set();
    let pageToken = null, pages = 0;
    do {
      const d = await search(query, key, pageToken);
      for (const p of d.places || []) {
        if (p.websiteUri) continue;                 // has a website -> skip
        const name = ((p.displayName || {}).text || '').trim();
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        leads.push({ trade, name, phone: p.nationalPhoneNumber || '', ...parseAddr(p.addressComponents) });
      }
      pageToken = d.nextPageToken; pages++;
      if (pageToken && pages < 2) { await new Promise((r) => setTimeout(r, 2100)); } else { pageToken = null; }
    } while (pageToken);
    res.status(200).json({ ok: true, query, count: leads.length, leads });
  } catch (e) {
    console.error('[find]', e);
    res.status(502).json({ error: String(e.message || e) });
  }
}
