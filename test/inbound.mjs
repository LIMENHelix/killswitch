process.env.KV_REST_API_URL = 'https://kv.test/';
process.env.KV_REST_API_TOKEN = 'token';
process.env.KS_PANEL_SECRET = 'panel-secret';
delete process.env.RESEND_API_KEY;
delete process.env.KS_PUBLIC_ORIGIN;

const KV = new Map();
globalThis.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://kv.test')) throw new Error('unexpected fetch ' + url);
  const input = JSON.parse(opts.body);
  const run = (a) => {
    const [op, key, field, value] = a;
    if (op === 'GET') return KV.has(key) ? KV.get(key) : null;
    if (op === 'SET') {
      if (a.slice(3).includes('NX') && KV.has(key)) return null;
      KV.set(key, field); return 'OK';
    }
    if (op === 'HGET') return (KV.get(key) || {})[field] ?? null;
    if (op === 'HGETALL') {
      const flat = [];
      for (const [k, v] of Object.entries(KV.get(key) || {})) flat.push(k, v);
      return flat;
    }
    if (op === 'HSET') { const h = KV.get(key) || {}; h[field] = value; KV.set(key, h); return 1; }
    if (op === 'HDEL') { const h = KV.get(key) || {}; delete h[field]; KV.set(key, h); return 1; }
    if (op === 'INCR') { const n = Number(KV.get(key) || 0) + 1; KV.set(key, String(n)); return n; }
    if (op === 'EXPIRE' || op === 'DEL') return 1;
    throw new Error('unsupported ' + op);
  };
  const result = String(url).endsWith('/pipeline')
    ? input.map((a) => ({ result: run(a) }))
    : { result: run(input) };
  return { ok: true, status: 200, json: async () => result, text: async () => JSON.stringify(result) };
};

const inbound = (await import('../api/inbound.js')).default;
const { getAccount, getLeads, upsertAccount } = await import('../lib/store.js');
const { siteForEmail, upsertSite } = await import('../lib/sites.js');

function response() {
  const out = { code: 0, body: null };
  out.status = (code) => { out.code = code; return out; };
  out.json = (body) => { out.body = body; return out; };
  out.setHeader = () => {};
  return out;
}

async function submit(body, host = 'attacker.example', ip = '127.0.0.1') {
  const res = response();
  await inbound({ method: 'POST', body, headers: { host, origin: 'https://' + host, 'x-forwarded-for': ip } }, res);
  return res;
}

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { console.log('  PASS  ' + name); passed++; }
  else { console.log('  FAIL  ' + name + (detail ? ' <- ' + detail : '')); failed++; }
}

console.log('\nPUBLIC SIGNUP IS THE FULL P0 FULFILLMENT PATH');
let res = await submit({
  email: 'owner@example.com', business: 'North Star Electric', phone: '(816) 555-0199',
  attribution: {
    source: 'google', medium: 'cpc', campaign: 'launch-plumbers',
    landingPage: '/free-website-for-plumbers-in-kansas-city', gclid: 'click-123',
    ignored: 'must not persist',
  },
});
check('signup succeeds', res.code === 200, JSON.stringify(res.body));
const account = await getAccount('owner@example.com');
const site = await siteForEmail('owner@example.com');
check('the account is created', account && account.plan.includes('P0'));
check('a real site is created and linked', site && site.slug === 'north-star-electric', JSON.stringify(site));
check('the site is live and customer-claimed', site.published && site.claimed);
check('the customer phone is on the page record', site.phone === '(816) 555-0199');
check('the response links the live site', res.body.siteUrl === 'https://killswitchwebsites.com/s/north-star-electric', res.body.siteUrl);
check('an attacker Host header cannot capture a panel token', !res.body.portalUrl && !JSON.stringify(res.body).includes('attacker.example'));
const inboundLead = (await getLeads()).find((lead) => lead.email === 'owner@example.com');
check('the signup is present on the lead board', !!inboundLead);
check('campaign attribution survives into operations',
  inboundLead.attribution?.source === 'google' && inboundLead.attribution?.campaign === 'launch-plumbers');
check('unrecognized attribution fields are rejected', !('ignored' in (inboundLead.attribution || {})));

console.log('\nREPEATED SIGNUP CANNOT DOWNGRADE A CUSTOMER');
await upsertAccount({ email: 'paid@example.com', name: 'Paid Original', site: 'Paid Original', plan: ['P0', 'P9'], owned: ['P3'], stripeCustomerId: 'cus_paid', createdAt: '2025-01-01T00:00:00.000Z', source: 'paid' });
await upsertSite({ business: 'Paid Original', email: 'paid@example.com', published: true, claimed: true, modules: ['P0', 'P3', 'P9'] });
res = await submit({ email: 'paid@example.com', business: 'Overwrite Attempt', phone: '816-555-0100' });
const paid = await getAccount('paid@example.com');
check('repeat signup still succeeds', res.code === 200, JSON.stringify(res.body));
check('paid plan survives unchanged', paid.plan.includes('P9'), JSON.stringify(paid.plan));
check('Stripe identity survives unchanged', paid.stripeCustomerId === 'cus_paid');
check('creation date and source survive unchanged', paid.createdAt === '2025-01-01T00:00:00.000Z' && paid.source === 'paid');
check('the existing business identity is preserved', paid.name === 'Paid Original' && paid.site === 'Paid Original');
check('the existing site remains the owned site', (await siteForEmail('paid@example.com')).slug === 'paid-original');

console.log('\nTHE /START INTAKE PERSISTS FACTS AND TREATS MODULES AS INTERESTS ONLY');
res = await submit({
  email: 'rivertown@example.com', business: 'Rivertown Plumbing', phone: '816-555-0123',
  name: 'Ada Ruiz', trade: 'plumber', city: 'Kansas City', state: 'MO',
  street: '417 Grand Blvd', zip: '64108', publicEmail: 'hello@rivertownplumbing.com',
  domain: 'rivertownplumbing.com',
  services: 'Leak repair\nWater heaters — installed same week\n\nDrain cleaning',
  hours: 'Mon to Fri: 8am to 6pm\nSat: 9am to 1pm',
  about: 'Family owned, third generation, we answer the phone ourselves.',
  interests: ['Online Booking', '24/7 AI Assistant', 'P9', 'free money'],
  notes: 'Red truck, call before arriving.',
  termsAcceptedAt: '2000-01-01T00:00:00.000Z',
}, 'attacker.example', '10.0.0.2');
check('the full intake signup succeeds', res.code === 200, JSON.stringify(res.body));
const rvSite = await siteForEmail('rivertown@example.com');
check('a real site is created and linked', rvSite && rvSite.slug === 'rivertown-plumbing', JSON.stringify(rvSite));
check('the factual trade is on the site record', rvSite.trade === 'plumber');
check('the factual city and state are on the site record', rvSite.city === 'Kansas City' && rvSite.state === 'MO');
check('the factual street and ZIP are on the site record', rvSite.street === '417 Grand Blvd' && rvSite.zip === '64108');
check('the public email is on the site record', rvSite.email_public === 'hello@rivertownplumbing.com');
check('customer-typed services REPLACE the generated trade menu',
  JSON.stringify(rvSite.services) === JSON.stringify([
    { name: 'Leak repair', desc: '' },
    { name: 'Water heaters', desc: 'installed same week' },
    { name: 'Drain cleaning', desc: '' },
  ]), JSON.stringify(rvSite.services));
check('the parsed hours are on the site record',
  JSON.stringify(rvSite.hours) === JSON.stringify([
    { d: 'Mon to Fri', h: '8am to 6pm' },
    { d: 'Sat', h: '9am to 1pm' },
  ]), JSON.stringify(rvSite.hours));
check('the customer about wins over the generated sentence',
  rvSite.about === 'Family owned, third generation, we answer the phone ourselves.', rvSite.about);
check('a new free site is P0 only', JSON.stringify(rvSite.modules) === JSON.stringify(['P0']), JSON.stringify(rvSite.modules));
check('the response links the live site', res.body.siteUrl === 'https://killswitchwebsites.com/s/rivertown-plumbing', res.body.siteUrl);
const rvAccount = await getAccount('rivertown@example.com');
check('the contact name is on the account', rvAccount.name === 'Ada Ruiz', JSON.stringify(rvAccount));
const rvLead = (await getLeads()).find((lead) => lead.email === 'rivertown@example.com');
check('the lead carries the contact name', rvLead.contactName === 'Ada Ruiz');
check('the lead carries trade, area, street, zip and public email',
  rvLead.trade === 'plumber' && rvLead.city === 'Kansas City' && rvLead.state === 'MO'
  && rvLead.street === '417 Grand Blvd' && rvLead.zip === '64108'
  && rvLead.publicEmail === 'hello@rivertownplumbing.com');
check('the lead carries domain and notes',
  rvLead.domain === 'rivertownplumbing.com' && rvLead.notes === 'Red truck, call before arriving.');
check('the lead carries the parsed services, hours and about',
  rvLead.services.length === 3 && rvLead.hours.length === 2
  && rvLead.about === 'Family owned, third generation, we answer the phone ourselves.');
check('recognised interests are recorded on the lead',
  JSON.stringify(rvLead.interests) === JSON.stringify(['Online Booking', '24/7 AI Assistant']), JSON.stringify(rvLead.interests));
check('interest junk is rejected, raw module ids included', rvLead.interests.every((i) => !/^P\d+$/.test(i)));
check('the Terms timestamp is server-generated, not client-sent',
  typeof rvLead.termsAcceptedAt === 'string'
  && !Number.isNaN(Date.parse(rvLead.termsAcceptedAt))
  && rvLead.termsAcceptedAt !== '2000-01-01T00:00:00.000Z'
  && Math.abs(Date.now() - Date.parse(rvLead.termsAcceptedAt)) < 5 * 60 * 1000, rvLead.termsAcceptedAt);

console.log('\nBACKWARD COMPATIBILITY: THE LEGACY area FIELD AND MINIMAL CALLERS');
res = await submit({
  email: 'legacy@example.com', business: 'Legacy Area Shop', phone: '816-555-0177',
  trade: 'bakery', area: 'Independence',
}, 'attacker.example', '10.0.0.8');
const legacySite = await siteForEmail('legacy@example.com');
check('a legacy caller still succeeds', res.code === 200, JSON.stringify(res.body));
check('the legacy area field still lands as the city', legacySite && legacySite.city === 'Independence', JSONSite(legacySite));
check('and the generated seed still fills what the caller left blank',
  legacySite && legacySite.about === 'Legacy Area Shop is a bakery in Independence.', legacySite && legacySite.about);
function JSONSite(s) { return JSON.stringify(s && { slug: s.slug, city: s.city }); }

console.log('\nSIGNUP CANNOT OVERWRITE A CLAIMED CUSTOMER\'S CONTENT WITH NEW FACTS');
await upsertSite({
  slug: 'harbour-electric', email: 'harbour@example.com', business: 'Harbour Electric',
  tagline: 'Wired right, first time.', about: 'Our own words since 2004.',
  services: [{ name: 'Panel upgrades', desc: '' }], theme: 'coastal', layout: 'classic',
  trade: 'electrician', city: 'Overland Park', published: true, claimed: true, modules: ['P0', 'P3'],
});
res = await submit({
  email: 'harbour@example.com', business: 'Harbour Electric', phone: '913-555-0180',
  trade: 'plumber', area: 'Topeka', interests: ['Payments'], notes: 'overwrite attempt',
}, 'attacker.example', '10.0.0.3');
const hs = await siteForEmail('harbour@example.com');
check('repeat signup still succeeds', res.code === 200, JSON.stringify(res.body));
check('their about line survives', hs.about === 'Our own words since 2004.');
check('their existing trade is not overwritten', hs.trade === 'electrician');
check('their existing city is not overwritten', hs.city === 'Overland Park');
check('their paid module survives, an interest activated nothing',
  JSON.stringify(hs.modules) === JSON.stringify(['P0', 'P3']), JSON.stringify(hs.modules));

console.log('\nEMPTY FIELDS ON AN EXISTING RECORD DO GET THE NEW FACTS FILLED');
await upsertSite({ slug: 'plain-garage', email: 'plain@example.com', business: 'Plain Garage', published: true, claimed: true, modules: ['P0'] });
res = await submit({ email: 'plain@example.com', business: 'Plain Garage', phone: '816-555-0199', trade: 'auto repair', area: 'Shawnee' }, 'attacker.example', '10.0.0.4');
const pg = await siteForEmail('plain@example.com');
check('repeat signup succeeds', res.code === 200, JSON.stringify(res.body));
check('an empty trade is filled from the signup facts', pg.trade === 'auto repair', pg.trade);
check('an empty city is filled from the signup facts', pg.city === 'Shawnee', pg.city);
check('nothing else about the record was invented', JSON.stringify(pg.modules) === JSON.stringify(['P0']));

console.log('\nEXTENDED FIELDS ARE VALIDATED, NOT TRUSTED');
res = await submit({ email: 'x@example.com', business: 'X Y', phone: '816-555-0100', interests: 'P9' }, 'attacker.example', '10.0.0.5');
check('non-array interests are rejected', res.code === 400 && res.body.error === 'interests_must_be_array', JSON.stringify(res.body));
res = await submit({ email: 'x@example.com', business: 'X Y', phone: '816-555-0100', notes: 'a'.repeat(2001) }, 'attacker.example', '10.0.0.6');
check('oversized notes are rejected', res.code === 400 && res.body.error === 'notes_too_long', JSON.stringify(res.body));
res = await submit({ email: 'x@example.com', business: 'X Y', phone: '816-555-0100', trade: 't'.repeat(81) }, 'attacker.example', '10.0.0.7');
check('oversized intake fields are rejected', res.code === 400 && res.body.error === 'intake_fields_too_long', JSON.stringify(res.body));

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
