process.env.KV_REST_API_URL = 'https://kv.test/';
process.env.KV_REST_API_TOKEN = 'token';
process.env.KS_PANEL_SECRET = 'panel-secret';
delete process.env.RESEND_API_KEY;
delete process.env.KS_PUBLIC_ORIGIN;

const KV = new Map();
globalThis.fetch = async (url, opts = {}) => {
  const target = String(url);
  // Turnstile verification. Only 'good-token' solves the challenge, so the test
  // can prove both the pass and the reject paths without any network.
  if (target.startsWith('https://challenges.cloudflare.com')) {
    const form = new URLSearchParams(String(opts.body || ''));
    const success = form.get('response') === 'good-token';
    return { ok: true, status: 200, json: async () => ({ success }), text: async () => '' };
  }
  if (target.startsWith('https://api.stripe.com')) {
    if (opts.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ id: 'cs_test_1', url: 'https://checkout.stripe.test/1' }), text: async () => '' };
    }
    const id = target.split('/').pop();
    const base = { id, customer_email: 'fee@example.com' };
    if (id === 'cs_unpaid') return { ok: true, status: 200, json: async () => ({ ...base, payment_status: 'unpaid', metadata: { kind: 'signup-fee' } }), text: async () => '' };
    if (id === 'cs_wrongkind') return { ok: true, status: 200, json: async () => ({ ...base, payment_status: 'paid', metadata: { kind: 'module' } }), text: async () => '' };
    return { ok: true, status: 200, json: async () => ({ ...base, payment_status: 'paid', metadata: { kind: 'signup-fee' } }), text: async () => '' };
  }
  if (!target.startsWith('https://kv.test')) throw new Error('unexpected fetch ' + url);
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
const accountApi = (await import('../api/account.js')).default;
const switchApi = (await import('../api/switch.js')).default;
const { getAccount, getLeads, upsertAccount } = await import('../lib/store.js');
const { siteForEmail, upsertSite } = await import('../lib/sites.js');
const { panelToken } = await import('../lib/panel-auth.js');

function response() {
  const out = { code: 0, body: null };
  out.status = (code) => { out.code = code; return out; };
  out.json = (body) => { out.body = body; return out; };
  out.setHeader = () => {};
  return out;
}

async function submit(body, host = 'attacker.example', ip = '127.0.0.1', geo = null) {
  const res = response();
  const headers = { host, origin: 'https://' + host, 'x-forwarded-for': ip };
  Object.assign(headers, geo || {});
  // Both traps are required now, so a normal case has to carry them the way the
  // real forms do. Tests that probe a trap override these deliberately.
  const payload = { website: '', elapsedMs: 5000, ...body };
  await inbound({ method: 'POST', body: payload, headers }, res);
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
}, 'attacker.example', '10.20.30.40', {
  'x-vercel-ip-city': 'Kansas%20City',
  'x-vercel-ip-country-region': 'MO',
  'x-vercel-ip-country': 'US',
  'x-vercel-ip-latitude': '39.0997',
  'x-vercel-ip-longitude': '-94.5786',
  'x-vercel-ip-timezone': 'America/Chicago',
  'user-agent': 'Mozilla/5.0 (test)',
});
check('signup succeeds', res.code === 200, JSON.stringify(res.body));
const account = await getAccount('owner@example.com');
const site = await siteForEmail('owner@example.com');
check('the account is created', account && account.plan.includes('P0'));
check('a real site is created and linked', site && site.slug === 'north-star-electric', JSON.stringify(site));
// A self-serve site does not exist in public at all until the customer proves
// they control the inbox they typed. Opening the panel link is what publishes it.
check('a new self-serve site is neither live nor claimed', !site.published && !site.claimed);
check('the customer phone is on the page record', site.phone === '(816) 555-0199');
check('no preview link is handed out for a site that is not live yet', res.body.siteUrl === undefined, String(res.body.siteUrl));
check('an attacker Host header cannot capture a panel token', !res.body.portalUrl && !JSON.stringify(res.body).includes('attacker.example'));
check('the signup IP is saved on the site record', site.signupIp === '10.20.30.40', site.signupIp);
check('the signup user-agent is saved on the site record', site.signupUserAgent === 'Mozilla/5.0 (test)', site.signupUserAgent);
check('the signup location is saved on the site record, city decoded',
  site.signupGeo && site.signupGeo.city === 'Kansas City' && site.signupGeo.region === 'MO'
  && site.signupGeo.country === 'US' && site.signupGeo.latitude === 39.0997
  && site.signupGeo.longitude === -94.5786 && site.signupGeo.timezone === 'America/Chicago',
  JSON.stringify(site.signupGeo));
check('the account carries the signup origin',
  account.signupIp === '10.20.30.40' && account.signupGeo && account.signupGeo.city === 'Kansas City',
  JSON.stringify(account.signupGeo));
const inboundLead = (await getLeads()).find((lead) => lead.email === 'owner@example.com');
check('the signup is present on the lead board', !!inboundLead);
check('the lead carries the same origin as the site',
  inboundLead.ip === '10.20.30.40' && inboundLead.userAgent === 'Mozilla/5.0 (test)'
  && inboundLead.geo && inboundLead.geo.city === 'Kansas City', JSON.stringify(inboundLead.geo));
check('campaign attribution survives into operations',
  inboundLead.attribution?.source === 'google' && inboundLead.attribution?.campaign === 'launch-plumbers');
check('unrecognized attribution fields are rejected', !('ignored' in (inboundLead.attribution || {})));

console.log('\nA FILLED HIDDEN FIELD OR INSTANT SUBMIT IS NOT A PERSON');
res = await submit({ email: 'bot@example.com', business: 'Bot Shop', phone: '816-555-0101', website: 'http://spam.example' }, 'attacker.example', '10.9.9.1');
check('a filled hidden field is rejected', res.code === 400 && res.body.error === 'invalid_request', JSON.stringify(res.body));
res = await submit({ email: 'bot2@example.com', business: 'Bot Shop Two', phone: '816-555-0102', elapsedMs: 50 }, 'attacker.example', '10.9.9.2');
check('a submission faster than a person can type is rejected', res.code === 400 && res.body.error === 'invalid_request', JSON.stringify(res.body));
check('a trapped request creates no account', !(await getAccount('bot@example.com')) && !(await getAccount('bot2@example.com')));
check('a trapped request creates no site', !(await siteForEmail('bot@example.com')));
res = await submit({ email: 'human@example.com', business: 'Human Shop', phone: '816-555-0103', elapsedMs: 5000 }, 'attacker.example', '10.9.9.3');
check('a human-paced submission with an empty hidden field passes', res.code === 200, JSON.stringify(res.body));
// The traps are required, not optional: a caller that omits them is not one of
// our forms. These call the handler directly because submit() supplies defaults.
const noTraps = response();
await inbound({ method: 'POST', body: { email: 'nt@example.com', business: 'No Traps', phone: '816-555-0202' }, headers: { host: 'attacker.example', 'x-forwarded-for': '10.6.6.1' } }, noTraps);
check('a signup that omits both trap fields is rejected', noTraps.code === 400 && noTraps.body.error === 'invalid_request', JSON.stringify(noTraps.body));
const noTime = response();
await inbound({ method: 'POST', body: { email: 'nt2@example.com', business: 'No Time', phone: '816-555-0203', website: '' }, headers: { host: 'attacker.example', 'x-forwarded-for': '10.6.6.2' } }, noTime);
check('a signup with no fill time is rejected', noTime.code === 400 && noTime.body.error === 'invalid_request', JSON.stringify(noTime.body));
check('neither trapped request created an account', !(await getAccount('nt@example.com')) && !(await getAccount('nt2@example.com')));

console.log('\nOPENING THE EMAILED PANEL LINK IS THE VERIFICATION GATE');
const token = await panelToken('owner@example.com');
check('a panel token can be minted for the signup address', !!token);
const wrong = response();
await accountApi({ method: 'GET', query: { e: 'owner@example.com', t: 'not-a-token' }, headers: {} }, wrong);
check('a bad token does not verify', wrong.code === 401, JSON.stringify(wrong.body));
const unclaimedStill = await siteForEmail('owner@example.com');
check('a bad token claims nothing', unclaimedStill.claimed === false);
check('a bad token publishes nothing', unclaimedStill.published === false);
const opened = response();
await accountApi({ method: 'GET', query: { e: 'owner@example.com', t: token }, headers: {} }, opened);
check('the panel link opens the account', opened.code === 200, JSON.stringify(opened.body));
const verified = await siteForEmail('owner@example.com');
check('opening the emailed link publishes and claims the site',
  verified.claimed === true && verified.published === true,
  JSON.stringify({ claimed: verified.claimed, published: verified.published }));
check('the verification time is recorded', typeof verified.verifiedAt === 'string' && verified.verifiedAt.length > 0);
const reopened = response();
await accountApi({ method: 'GET', query: { e: 'owner@example.com', t: token }, headers: {} }, reopened);
const twice = await siteForEmail('owner@example.com');
check('reopening the panel link is idempotent', twice.claimed === true && twice.published === true);

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
check('no preview link is handed out for a site that is not live yet', res.body.siteUrl === undefined, String(res.body.siteUrl));
check('the signup message points them at the emailed link', /panel link/i.test(res.body.message || ''), res.body.message);
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

console.log('\nTURNSTILE IS THE GATE ONCE A SECRET IS CONFIGURED');
// Unconfigured is the state every test above ran in: no token is asked for and
// signup works. Now turn it on and prove the other half.
process.env.TURNSTILE_SECRET_KEY = 'test-secret';
res = await submit({ email: 'ts0@example.com', business: 'TS Zero', phone: '816-555-0200' }, 'attacker.example', '10.8.8.1');
check('a signup with no token is rejected once configured',
  res.code === 400 && res.body.error === 'verification_required', JSON.stringify(res.body));
res = await submit({ email: 'ts1@example.com', business: 'TS One', phone: '816-555-0201', turnstileToken: 'bad-token' }, 'attacker.example', '10.8.8.2');
check('a failed challenge is rejected',
  res.code === 400 && res.body.error === 'verification_failed', JSON.stringify(res.body));
check('a rejected challenge creates no account', !(await getAccount('ts1@example.com')));
check('a rejected challenge creates no site', !(await siteForEmail('ts1@example.com')));
res = await submit({ email: 'ts2@example.com', business: 'TS Two', phone: '816-555-0202', turnstileToken: 'good-token' }, 'attacker.example', '10.8.8.3');
check('a solved challenge passes', res.code === 200, JSON.stringify(res.body));
delete process.env.TURNSTILE_SECRET_KEY;

console.log('\nTHE PANEL ITSELF IS WHAT PUBLISHES A VERIFIED SITE');
// The panel never calls /api/account; it calls /api/switch. That path has to be
// the one that lifts the 404, or a site created by A can never go live at all.
await submit({ email: 'panel@example.com', business: 'Panel Proof Co', phone: '816-555-0300' }, 'attacker.example', '10.7.7.1');
const beforePanel = await siteForEmail('panel@example.com');
check('a fresh signup site is a 404', !!beforePanel && !beforePanel.published && !beforePanel.claimed,
  JSON.stringify({ published: beforePanel && beforePanel.published, claimed: beforePanel && beforePanel.claimed }));
const ptok = await panelToken('panel@example.com');
const sw = response();
await switchApi({ method: 'POST', body: { action: 'state', e: 'panel@example.com', t: ptok }, headers: {} }, sw);
const afterPanel = await siteForEmail('panel@example.com');
check('opening the panel publishes and claims it',
  afterPanel.published === true && afterPanel.claimed === true,
  JSON.stringify({ published: afterPanel.published, claimed: afterPanel.claimed }));
check('the panel response carries the live address',
  sw.body && sw.body.siteUrl === '/s/panel-proof-co', JSON.stringify(sw.body && sw.body.siteUrl));

console.log('\nA CONFIGURED SETUP FEE CREATES NOTHING UNTIL STRIPE SAYS PAID');
process.env.SIGNUP_FEE_CENTS = '100';
process.env.STRIPE_SECRET_KEY = 'sk_test_fee';
res = await submit({ email: 'fee@example.com', business: 'Fee Shop', phone: '816-555-0400' }, 'attacker.example', '10.5.5.1');
check('an unpaid signup is sent to checkout instead of creating a site',
  res.code === 200 && res.body.requiresPayment === true && !!res.body.checkoutUrl, JSON.stringify(res.body));
check('the fee is one dollar', res.body.feeCents === 100, String(res.body.feeCents));
check('nothing was created before payment', !(await getAccount('fee@example.com')) && !(await siteForEmail('fee@example.com')));
res = await submit({ email: 'fee@example.com', business: 'Fee Shop', phone: '816-555-0400', paymentSession: 'cs_unpaid' }, 'attacker.example', '10.5.5.2');
check('an unsettled payment provisions nothing', res.code === 402 && res.body.error === 'payment_not_complete', JSON.stringify(res.body));
check('the unsettled attempt created nothing', !(await siteForEmail('fee@example.com')));
res = await submit({ email: 'fee@example.com', business: 'Fee Shop', phone: '816-555-0400', paymentSession: 'cs_wrongkind' }, 'attacker.example', '10.5.5.3');
check('a different kind of Stripe charge cannot buy a site', res.code === 400 && res.body.error === 'not_a_signup_fee', JSON.stringify(res.body));
res = await submit({ email: 'fee@example.com', business: 'Fee Shop', phone: '816-555-0400', paymentSession: 'cs_paid_ok' }, 'attacker.example', '10.5.5.4');
check('a paid fee creates the site', res.code === 200 && res.body.ok === true, JSON.stringify(res.body));
const feeSite = await siteForEmail('fee@example.com');
check('the paid site exists and is still unverified', !!feeSite && feeSite.published === false && feeSite.claimed === false,
  JSON.stringify(feeSite && { published: feeSite.published, claimed: feeSite.claimed }));
res = await submit({ email: 'fee@example.com', business: 'Fee Shop', phone: '816-555-0400', paymentSession: 'cs_paid_ok' }, 'attacker.example', '10.5.5.5');
check('one payment cannot be replayed for a second site', res.code === 400 && res.body.error === 'payment_already_used', JSON.stringify(res.body));
delete process.env.SIGNUP_FEE_CENTS;
delete process.env.STRIPE_SECRET_KEY;

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
