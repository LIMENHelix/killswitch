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

async function submit(body, host = 'attacker.example') {
  const res = response();
  await inbound({ method: 'POST', body, headers: { host, origin: 'https://' + host, 'x-forwarded-for': '127.0.0.1' } }, res);
  return res;
}

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { console.log('  PASS  ' + name); passed++; }
  else { console.log('  FAIL  ' + name + (detail ? ' <- ' + detail : '')); failed++; }
}

console.log('\nPUBLIC SIGNUP IS THE FULL P0 FULFILLMENT PATH');
let res = await submit({ email: 'owner@example.com', business: 'North Star Electric', phone: '(816) 555-0199' });
check('signup succeeds', res.code === 200, JSON.stringify(res.body));
const account = await getAccount('owner@example.com');
const site = await siteForEmail('owner@example.com');
check('the account is created', account && account.plan.includes('P0'));
check('a real site is created and linked', site && site.slug === 'north-star-electric', JSON.stringify(site));
check('the site is live and customer-claimed', site.published && site.claimed);
check('the customer phone is on the page record', site.phone === '(816) 555-0199');
check('the response links the live site', res.body.siteUrl === 'https://killswitchwebsites.com/s/north-star-electric', res.body.siteUrl);
check('an attacker Host header cannot capture a panel token', !res.body.portalUrl && !JSON.stringify(res.body).includes('attacker.example'));
check('the signup is present on the lead board', (await getLeads()).some((lead) => lead.email === 'owner@example.com'));

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

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
