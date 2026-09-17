// THE SECOND FRONT DOOR.
//
// draftFromLead() seeds the cold-outreach path. ensureCustomerSite() is the
// path a real customer arrives through: the homepage form (api/inbound.js) and
// a Stripe payment link (api/stripe-webhook.js). Until now only the first one
// seeded, so somebody who PAID got a barer website than a prospect who never
// asked for one. That is how old-school-iron ended up as four blocks.
//
// The seam this guards is not "does seeding work" (test/site-seed.mjs covers
// that). It is WHICH BRANCH seeds. ensureCustomerSite has three, and only the
// last one creates a record:
//   1. an email already linked to a site   -> must not be reseeded
//   2. claiming an unowned prospect draft  -> must not be reseeded
//   3. a genuinely new record              -> seeds
// A change that seeded branch 1 or 2 would overwrite live customer copy, which
// is worse than the bug it fixes. Each branch is asserted separately below.
process.env.KV_REST_API_URL = 'https://kv.test/';
process.env.KV_REST_API_TOKEN = 'kvtok';

const KV = new Map();
globalThis.fetch = async (url, opts = {}) => {
  const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  const args = JSON.parse(opts.body);
  const run = (a) => {
    const c = String(a[0]).toUpperCase(), k = a[1];
    if (c === 'GET') return KV.has(k) ? KV.get(k) : null;
    if (c === 'SET') { KV.set(k, a[2]); return 'OK'; }
    if (c === 'DEL') { const had = KV.has(k); KV.delete(k); return had ? 1 : 0; }
    if (c === 'HSET') { const h = KV.get(k) || {}; h[a[2]] = a[3]; KV.set(k, h); return 1; }
    if (c === 'HGET') { const h = KV.get(k) || {}; return h[a[2]] == null ? null : h[a[2]]; }
    if (c === 'HDEL') { const h = KV.get(k) || {}; const had = a[2] in h; delete h[a[2]]; KV.set(k, h); return had ? 1 : 0; }
    if (c === 'HGETALL') { const h = KV.get(k) || {}; const o = []; for (const [f, v] of Object.entries(h)) o.push(f, v); return o; }
    throw new Error('unsupported kv command in test: ' + c);
  };
  if (String(url).endsWith('/pipeline')) return json(args.map((a) => ({ result: run(a) })));
  return json({ result: run(args) });
};

const { ensureCustomerSite } = await import('../lib/autonomy.js');
const { getSite, upsertSite } = await import('../lib/sites.js');
const { renderSite } = await import('../lib/site-template.js');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };
const sections = (html) => (html.match(/<section[^>]*id="([a-z]+)"/g) || []).map((s) => s.match(/id="([a-z]+)"/)[1]);

// ---------------------------------------------------------------------------
console.log('\n1. A DIRECT STRIPE PAYMENT WITH NO PRIOR DRAFT');

const paid = await ensureCustomerSite({
  email: 'buyer@example.com', business: 'Cedar Ridge Plumbing',
  trade: 'plumber', source: 'stripe-payment',
});

check('a record is created', paid.created === true && !!paid.site);
check('it is the paying customer\'s', paid.site.email === 'buyer@example.com');
check('it is live and claimed', paid.site.published === true && paid.site.claimed === true);
check('it is free-tier only, payment did not grant modules', JSON.stringify(paid.site.modules) === JSON.stringify(['P0']));

check('SEEDED: NO service list comes from category alone', paid.site.services.length === 0, JSON.stringify(paid.site.services));
check('SEEDED: it has a theme', paid.site.theme === 'bold', paid.site.theme);
check('SEEDED: it has the demo layout', paid.site.layout === 'trade', paid.site.layout);
check('SEEDED: it has a factual about line',
  paid.site.about === 'Cedar Ridge Plumbing is a plumbing business.', paid.site.about);
check('the about line invents no location it was never given',
  !/\bin\b/.test(paid.site.about));

const paidHtml = renderSite(paid.site, { base: 'https://killswitchwebsites.com' });
check('and the page carries the factual sections, not an invented menu',
  sections(paidHtml).includes('about') && !sections(paidHtml).includes('services'),
  sections(paidHtml).join(','));

// ---------------------------------------------------------------------------
console.log('\n2. WITHOUT A TRADE, IT STILL REFUSES TO GUESS');

const noTrade = await ensureCustomerSite({
  email: 'walkin@example.com', business: 'Bright Star Holdings', source: 'stripe-payment',
});
check('a record is still created', noTrade.created === true);
check('it gets a factual about line', noTrade.site.about === 'Bright Star Holdings is a local business.', noTrade.site.about);
check('but NO service menu is invented from a bare name', noTrade.site.services.length === 0);
check('it still gets a shipped theme', typeof noTrade.site.theme === 'string' && noTrade.site.theme.length > 0);

// ---------------------------------------------------------------------------
console.log('\n3. AN EXISTING CLAIMED SITE IS NEVER RESEEDED');

await upsertSite({
  slug: 'harbour-electric', email: 'owner@example.com', business: 'Harbour Electric',
  tagline: 'Wired right, first time.', about: 'We have run out of this shop since 2004.',
  services: [{ name: 'Panel upgrades', desc: 'Our own words' }],
  theme: 'coastal', layout: 'classic', published: true, claimed: true, modules: ['P0'],
});

const again = await ensureCustomerSite({
  email: 'owner@example.com', business: 'Harbour Electric', trade: 'electrician', phone: '913-555-0180',
});

check('the linked branch reports it created nothing', again.created === false);
check('their own about line survives', again.site.about === 'We have run out of this shop since 2004.', again.site.about);
check('their own tagline survives', again.site.tagline === 'Wired right, first time.');
check('their own single service is NOT topped up to six', again.site.services.length === 1, JSON.stringify(again.site.services));
check('their chosen colour survives', again.site.theme === 'coastal');
check('their chosen layout survives', again.site.layout === 'classic');
check('the phone it was missing is still filled in', again.site.phone === '913-555-0180');

// ---------------------------------------------------------------------------
console.log('\n4. CLAIMING AN UNOWNED PROSPECT DRAFT DOES NOT RESEED IT EITHER');

await upsertSite({
  slug: 'north-fork-roofing', business: 'North Fork Roofing', email: '',
  tagline: 'Roofing in Lenexa, KS', about: 'North Fork Roofing is a roofing business in Lenexa, KS.',
  services: [{ name: 'Storm damage', desc: '' }],
  theme: 'bold', layout: 'trade', published: false, claimed: false, modules: ['P0'],
});

const claimed = await ensureCustomerSite({
  email: 'north@example.com', business: 'North Fork Roofing', trade: 'roofer',
});

check('the collision branch reports it created nothing', claimed.created === false);
check('the draft is bound to the new owner', claimed.site.email === 'north@example.com');
check('claiming publishes it', claimed.site.published === true && claimed.site.claimed === true);
check('the draft\'s existing single service is NOT replaced by the full menu',
  claimed.site.services.length === 1, JSON.stringify(claimed.site.services));
check('the draft\'s about line is unchanged',
  claimed.site.about === 'North Fork Roofing is a roofing business in Lenexa, KS.');

// ---------------------------------------------------------------------------
console.log('\n5. A SITE OWNED BY SOMEBODY ELSE IS STILL NEVER TOUCHED');

await upsertSite({
  slug: 'apex-tyres', business: 'Apex Tyres', email: 'first@example.com',
  published: true, claimed: true, modules: ['P0'],
});
const before = await getSite('apex-tyres');
const intruder = await ensureCustomerSite({ email: 'second@example.com', business: 'Apex Tyres', trade: 'auto repair' });
const after = await getSite('apex-tyres');

check('the original owner keeps the record', after.email === 'first@example.com');
check('nothing about it changed', JSON.stringify(before) === JSON.stringify(after));
check('the newcomer got a different slug', intruder.site.slug !== 'apex-tyres', intruder.site.slug);
check('and the newcomer\'s own site is seeded with factual content, not an invented menu',
  intruder.site.about === 'Apex Tyres is an auto repair business.' && intruder.site.services.length === 0, intruder.site.about);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
