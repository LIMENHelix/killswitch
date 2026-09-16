// CUSTOMER-SITE QUALITY GATE + SEO tests.
//
// Representative businesses walk the real generator (draftFromLead / seedMissing
// / renderSite) and the real validator (lib/site-quality.js):
//
//   auto repair, plumber, salon/barber   -> full pages, trade schema subtypes
//   engineering (Solid Ground's shape)   -> thin record becomes publishable
//                                            after seedMissing, generic schema
//   sparse-data business                 -> FAILS with exact blockers, stays
//                                            unpublished at the publish action
//
// Plus the gate at the admin publish action (422, exact reasons), the K5
// quality_blocked path, seedMissing enrichment on the signup path, and the
// fabrication ban (no invented years, reviews, awards, or service promises).

process.env.KV_REST_API_URL = 'https://kv.sitequality.test';
process.env.KV_REST_API_TOKEN = 'token';
process.env.ADMIN_KEY = 'owner-key';
delete process.env.VERCEL_ENV;

import { setupKvStub, clearKvStub } from './helpers/k6-kv.mjs';

const { KV, EXP } = setupKvStub();

const { validatePublishable } = await import('../lib/site-quality.js');
const { draftFromLead } = await import('../lib/draft-site.js');
const { seedMissing } = await import('../lib/site-seed.js');
const { renderSite } = await import('../lib/site-template.js');
const { SITE_DEFAULT } = await import('../lib/sites.js');
const { ensureCustomerSite } = await import('../lib/autonomy.js');
const { _draftCandidate } = await import('../lib/draft-autonomy.js');
const admin = (await import('../api/admin.js')).default;

let pass = 0, fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) { console.log('  PASS  ' + name); pass++; }
  else { console.log('  FAIL  ' + name + (detail ? '  <- ' + detail : '')); fail++; }
};

const schemaOf = (html) => {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]) : null;
};
const metaDesc = (html) => (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
const taken = () => new Set();

const LEADS = {
  // Owner/intake-backed services: the /start form stores them on the lead.
  auto: { id: 'fx-auto', name: 'Rivertown Auto Repair', trade: 'auto repair', phone: '816-555-0142',
    street: '10 Main St', city: 'Kansas City', state: 'MO', zip: '64108',
    hours: [{ d: 'Mon to Fri', h: '8am to 6pm' }],
    services: [{ name: 'Brakes', desc: 'Pads and rotors' }, { name: 'Diagnostics', desc: '' }] },
  plumber: { id: 'fx-plumb', name: 'Blue River Plumbing', trade: 'plumber', phone: '816-555-0199',
    street: '22 Oak St', city: 'Independence', state: 'MO', zip: '64050' },
  salon: { id: 'fx-salon', name: 'Fade House', trade: 'salon/barber', phone: '913-555-0110',
    street: '5 Elm St', city: 'Overland Park', state: 'KS', zip: '66204' },
  // Solid Ground Engineering's real shape: name, custom trade, town, phone — nothing else.
  engineering: { id: 'fx-eng', name: 'Solid Ground Engineering', trade: 'Engineering and Drafting',
    phone: '619-555-0177', city: 'Eureka', state: 'CA' },
  sparse: { id: 'fx-sparse', name: 'Mystery Shop', phone: '816-555-0100' },
};

// ---------------------------------------------------------------------------
console.log('\nREPRESENTATIVE SITES PASS THE GATE AND RENDER COMPLETE SEO');

const built = {};
for (const k of ['auto', 'plumber', 'salon']) {
  const rec = draftFromLead(LEADS[k], taken());
  built[k] = rec;
  const q = validatePublishable(rec);
  check(k + ': passes the publish gate', q.ok, q.blockers.join(';'));
  const html = renderSite(rec);
  const schema = schemaOf(html);
  check(k + ': title is useful', html.includes('<title>' + rec.business + ' · ' + rec.city), (html.match(/<title>[^<]*/) || [''])[0]);
  check(k + ': meta description is factual and useful', metaDesc(html).length > 20 && metaDesc(html).includes(rec.city), metaDesc(html));
  check(k + ': canonical + OG present', html.includes('rel="canonical"') && html.includes('property="og:title"'));
  check(k + ': schema names the business with a telephone', schema && schema.name === rec.business && schema.telephone === rec.phone);
  check(k + ': schema carries the address and area served', schema && schema.address && schema.address.addressLocality === rec.city && schema.areaServed && schema.areaServed['@type'] === 'City');
  check(k + ': contact form renders', html.includes('name="message"'));
  check(k + ': responsive rules and viewport are in the page', html.includes('width=device-width') && /@media\(max-width/.test(html));
}
check('owner-backed services render on the page', renderSite(built.auto).includes('id="services"') && renderSite(built.auto).includes('Brakes'));
check('category alone renders NO services section (plumber)', !renderSite(built.plumber).includes('id="services"'));
check('category alone renders NO services section (salon)', !renderSite(built.salon).includes('id="services"'));
check('and the trade menu text never leaks anywhere', !renderSite(built.plumber).includes('Drain cleaning') && !renderSite(built.salon).includes('Haircut'));
check('auto repair gets the AutoRepair schema subtype', schemaOf(renderSite(built.auto))['@type'] === 'AutoRepair');
check('plumber gets the Plumber schema subtype', schemaOf(renderSite(built.plumber))['@type'] === 'Plumber');
check('salon gets the HairSalon schema subtype', schemaOf(renderSite(built.salon))['@type'] === 'HairSalon');
check('opening hours appear in schema only when known',
  schemaOf(renderSite(built.auto)).openingHours && schemaOf(renderSite(built.auto)).openingHours[0] === 'Mon to Fri: 8am to 6pm'
  && !schemaOf(renderSite(built.plumber)).openingHours);
check('the Google profile link stays the P1 extra', !schemaOf(renderSite(built.auto)).sameAs);

console.log('\nNO FABRICATED FACTS, ON ANY FIXTURE');
const allHtml = Object.values(built).map((r) => renderSite(r)).join('\n');
for (const invented of ['years in business', 'since 19', '5 star', 'reviews', 'award', 'family owned', 'licensed and insured', 'Emergency service', 'Free estimates']) {
  check('never prints "' + invented + '"', !allHtml.toLowerCase().includes(invented.toLowerCase()));
}

// ---------------------------------------------------------------------------
console.log('\nTHE MEASURED THIN SITE: PUBLISHABLE AFTER FACTUAL COMPLETION');
const thin = { ...SITE_DEFAULT, slug: 'solid-ground-engineering', business: 'Solid Ground Engineering',
  trade: 'Engineering and Drafting', phone: '619-555-0177', city: 'Eureka', state: 'CA', modules: ['P0'] };
const beforeQ = validatePublishable(thin);
check('the raw thin record fails the gate', !beforeQ.ok && beforeQ.blockers.includes('thin_render_no_content_sections'), beforeQ.blockers.join(';'));
const completed = { ...thin, ...seedMissing(thin) };
const afterQ = validatePublishable(completed);
check('after seedMissing it passes', afterQ.ok, afterQ.blockers.join(';'));
const engHtml = renderSite(completed);
check('the about section renders from facts', engHtml.includes('About Solid Ground Engineering') && engHtml.includes('engineering and drafting'));
check('an unknown trade falls back to LocalBusiness schema', schemaOf(engHtml)['@type'] === 'LocalBusiness');
check('no service menu was invented for it', !engHtml.includes('id="services"'));

// ---------------------------------------------------------------------------
console.log('\nSPARSE DATA: EXPLICIT BLOCKERS, STAYS UNPUBLISHED');
const sparseRec = draftFromLead(LEADS.sparse, taken());
const sparseQ = validatePublishable(sparseRec);
check('a name-and-phone record fails', !sparseQ.ok);
check('the blockers are the exact missing facts', sparseQ.blockers.includes('no_usable_trade') && sparseQ.blockers.includes('no_usable_location') && sparseQ.blockers.includes('missing_useful_meta_description'), sparseQ.blockers.join(';'));

KV.clear(); EXP.clear();
KV.set('ks:leads', JSON.stringify([{ id: 'fx-sparse', name: 'Mystery Shop', phone: '816-555-0100' }]));
KV.set('ks:leadmeta', { 'fx-sparse': JSON.stringify({ siteSlug: 'mystery-shop' }) });
KV.set('ks:site:mystery-shop', JSON.stringify({ ...SITE_DEFAULT, ...sparseRec, slug: 'mystery-shop' }));
const mkres = () => { const r = { code: 0, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (o) => { r.body = o; return r; }; return r; };
let res = mkres();
await admin({ method: 'POST', headers: {}, body: { action: 'site-publish', token: 'owner-key', id: 'fx-sparse' } }, res);
check('site-publish refuses with 422 and exact blockers', res.code === 422 && res.body.error === 'site_not_publishable' && res.body.blockers.includes('no_usable_trade'), JSON.stringify(res.body));
check('and the draft stays unpublished', JSON.parse(KV.get('ks:site:mystery-shop')).published === false);

console.log('\nK5: A QUALITY-FAILING CANDIDATE IS NEVER DRAFTED');
const badCand = { placeId: 'plc-bad-1', name: 'Nowhere Works', category: '', status: 'ranked', score: 90,
  street: '', city: '', state: '', zip: '', phone: '816-555-0100', hours: [] };
const dres = await _draftCandidate(badCand, { taken: new Set(), placeIndex: {}, siteList: [], owner: 't', runId: 'r', draftsPerRun: 1 }, new Date().toISOString());
check('the draft attempt is quality_blocked with reasons', dres.action === 'quality_blocked' && /no_usable_trade/.test(dres.reason), JSON.stringify(dres));

// ---------------------------------------------------------------------------
console.log('\nMALFORMED, PLACEHOLDER AND UNSAFE CONTENT FAIL VISIBLY');
const base = { ...SITE_DEFAULT, business: 'Gate Shop', trade: 'bakery', city: 'Kansas City', state: 'MO', services: [{ name: 'Bread', desc: '' }] };
check('a short phone is a blocker', validatePublishable({ ...base, phone: '555-12' }).blockers.includes('malformed_phone'));
check('a bad public email is a blocker', validatePublishable({ ...base, email_public: 'not-an-email' }).blockers.includes('malformed_public_email'));
check('placeholder copy is a blocker', validatePublishable({ ...base, about: 'Lorem ipsum dolor sit amet' }).blockers.includes('placeholder_content'));
const unsafe = validatePublishable({ ...base, about: 'Nice shop <script>alert(1)</script>' });
check('script-shaped content is a blocker', unsafe.blockers.includes('unsafe_content'));
check('and the render escapes it anyway', !renderSite({ ...base, about: 'Nice shop <script>alert(1)</script>' }).includes('<script>alert(1)</script>'));
check('a missing trade is a blocker', validatePublishable({ ...base, trade: '' }).blockers.includes('no_usable_trade'));
check('a missing location is a blocker', validatePublishable({ ...base, city: '', state: '' }).blockers.includes('no_usable_location'));

// ---------------------------------------------------------------------------
console.log('\nSIGNUP PATH: THIN EXISTING RECORDS GET COMPLETED, NEVER REWRITTEN');
KV.clear(); EXP.clear();
KV.set('ks:site:river-auto', JSON.stringify({ ...SITE_DEFAULT, slug: 'river-auto', business: 'River Auto',
  trade: 'auto repair', city: 'Kansas City', state: 'MO', email: 'owner@river.test',
  about: 'Family owned, we answer the phone ourselves.', published: true, claimed: true, modules: ['P0'] }));
KV.set('ks:siteidx', { 'river-auto': JSON.stringify({ business: 'River Auto', email: 'owner@river.test' }) });
KV.set('ks:siteemail', { 'owner@river.test': 'river-auto' });
const out = await ensureCustomerSite({ email: 'owner@river.test', business: 'River Auto', trade: 'auto repair', city: 'Kansas City', state: 'MO' });
check('empty fields are completed from facts', out.site.tagline.includes('Kansas City') && out.site.theme === 'bold');
check('no service list is invented on the signup path either', out.site.services.length === 0);
check('the owner words are NEVER overwritten', out.site.about === 'Family owned, we answer the phone ourselves.');

KV.clear(); EXP.clear();
const own = await ensureCustomerSite({ email: 'new@svc.test', business: 'Svc Shop', trade: 'plumber', city: 'Kansas City', state: 'MO',
  services: [{ name: 'Leak repair', desc: '' }] });
check('owner-typed services DO land on a brand new record', own.site.services.length === 1 && own.site.services[0].name === 'Leak repair');
check('and the gate passes on that record', validatePublishable(own.site).ok);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
clearKvStub();
process.exit(fail ? 1 : 0);
