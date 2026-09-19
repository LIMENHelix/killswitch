// K6 cron-mail endpoint tests (SIMULATED — no real provider, no real send).
//
// Covers every cron auth branch (Bearer CRON_SECRET only) and a provider-
// stubbed end-to-end trace: auth -> armed synthetic config -> eligible
// prospect -> durable effect reservation -> cap reservation -> Lob adapter
// with a fake provider -> accepted ledger state. Run twice: one logical
// effect, one provider invocation, one cap reservation.

process.env.KV_REST_API_URL = 'https://kv.cronmail.test';
process.env.KV_REST_API_TOKEN = 'token';
process.env.CRON_SECRET = 'test-cron-secret';
process.env.ADMIN_KEY = 'test-admin-key';
process.env.SWITCH_TOKEN = 'test-switch-token';
process.env.LOB_API_KEY = 'lob_test_key';
process.env.KS_FROM_NAME = 'Killswitch Websites';
process.env.KS_FROM_LINE1 = '123 Main St';
process.env.KS_FROM_CITY = 'Kansas City';
process.env.KS_FROM_STATE = 'KS';
process.env.KS_FROM_ZIP = '64108';
delete process.env.VERCEL_ENV;

import { setupKvStub, clearKvStub } from './helpers/k6-kv.mjs';

const { KV, EXP } = setupKvStub();

let lobCalls = [];
const kvFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u === 'https://api.lob.com/v1/postcards') {
    lobCalls.push({ idempotency: options.headers && options.headers['Idempotency-Key'] });
    return { ok: true, status: 200, json: async () => ({ id: 'psc_sim_' + lobCalls.length }) };
  }
  return kvFetch(url, options);
};

const handler = (await import('../api/cron-mail.js')).default;
const { CFG_KEY } = await import('../lib/k6-outreach.js');
const { getRunEffects, getStatusCounts, STATUS } = await import('../lib/outreach-effects.js');
const { upsertAccount } = await import('../lib/store.js');

let pass = 0, fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) { console.log('  PASS  ' + name); pass++; }
  else { console.log('  FAIL  ' + name + (detail ? '  <- ' + detail : '')); fail++; }
};

function mkres() {
  const r = { code: 0, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  return r;
}
async function call({ headers = {}, query = {}, body } = {}) {
  const res = mkres();
  await handler({ method: 'GET', headers, query, body }, res);
  return res;
}

const ARMED = {
  enabled: true, mode: 'test', channels: ['postcard'],
  perRunCap: 5, dailyCap: 10, lifetimeCap: 20, perRunSpendCap: 1000, dailySpendCap: 2000,
  postcardReserveCents: 94,
};
const LEAD = {
  id: 'sim-lead-1', name: 'Sim Auto', business: 'Sim Auto',
  street: '9 Main St', city: 'Kansas City', state: 'MO', zip: '64108',
};

function seed(armed = true) {
  KV.clear();
  EXP.clear();
  lobCalls = [];
  if (armed) KV.set(CFG_KEY, JSON.stringify(ARMED));
  KV.set('ks:leads', JSON.stringify([LEAD]));
}

console.log('\nCRON AUTH: BEARER CRON_SECRET ONLY');
seed();
const savedSecret = process.env.CRON_SECRET;
delete process.env.CRON_SECRET;
check('missing CRON_SECRET rejects even a well-formed bearer', (await call({ headers: { authorization: 'Bearer test-cron-secret' } })).code === 401);
process.env.CRON_SECRET = savedSecret;
check('missing Authorization rejects', (await call()).code === 401);
check('wrong scheme rejects', (await call({ headers: { authorization: 'Token test-cron-secret' } })).code === 401);
check('wrong bearer value rejects', (await call({ headers: { authorization: 'Bearer wrong' } })).code === 401);
check('query token equal to CRON_SECRET rejects', (await call({ query: { token: 'test-cron-secret' } })).code === 401);
check('query token equal to ADMIN_KEY rejects', (await call({ query: { token: 'test-admin-key' } })).code === 401);
check('query token equal to SWITCH_TOKEN rejects', (await call({ query: { token: 'test-switch-token' } })).code === 401);
check('body token equal to CRON_SECRET rejects', (await call({ body: { token: 'test-cron-secret' } })).code === 401);
check('x-vercel-cron header alone rejects', (await call({ headers: { 'x-vercel-cron': '1' } })).code === 401);
check('correct Bearer secret accepts', (await call({ headers: { authorization: 'Bearer test-cron-secret' } })).code === 200);
check('a near-miss bearer (one char off) rejects', (await call({ headers: { authorization: 'Bearer test-cron-secreX' } })).code === 401);

console.log('\nUNARMED CONFIG FAILS CLOSED (SIMULATED)');
seed(false);
let r = await call({ headers: { authorization: 'Bearer test-cron-secret' } });
check('no config stored: 200 but nothing ran', r.code === 200 && r.body.ran === false && r.body.reason === 'not_armed');
check('no provider call while unarmed', lobCalls.length === 0);

console.log('\nSIMULATED END-TO-END TRACE (fake provider, synthetic caps)');
seed();
r = await call({ headers: { authorization: 'Bearer test-cron-secret' } });
check('the run sent the one eligible prospect', r.code === 200 && r.body.ran === true && r.body.sent === 1, JSON.stringify(r.body));
const firstCronRunId = r.body.run.id;
check('exactly one provider invocation happened', lobCalls.length === 1);
check('the provider call carried a durable Idempotency-Key', typeof lobCalls[0].idempotency === 'string' && lobCalls[0].idempotency.startsWith('oe-'));
const counts1 = await getStatusCounts();
check('the ledger holds one accepted effect', counts1[STATUS.ACCEPTED] === 1);

r = await call({ headers: { authorization: 'Bearer test-cron-secret' } });
check('the same trace twice sends nothing new', r.body.sent === 0);
check('the second cron run gets its own fresh runId', r.body.run.id !== firstCronRunId);
check('still exactly one provider invocation', lobCalls.length === 1);
const effects = await getRunEffects(firstCronRunId);
check('still exactly one cap reservation', effects.rc === 1);
check('still exactly one logical effect', effects.effects.length === 1 && effects.effects[0].status === STATUS.ACCEPTED && effects.effects[0].providerRef === 'psc_sim_1');

console.log('\nPROSPECT BECOMES A CUSTOMER: ZERO PROVIDER INVOCATION (SIMULATED)');
seed();
await upsertAccount({ email: 'owner@simauto.test', plan: ['P1'], stripeCustomerId: 'cus_sim' });
KV.set('ks:leads', JSON.stringify([{ ...LEAD, email: 'owner@simauto.test' }]));
r = await call({ headers: { authorization: 'Bearer test-cron-secret' } });
check('an existing customer is never called at the provider', r.body.sent === 0 && lobCalls.length === 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
clearKvStub();
process.exit(fail ? 1 : 0);
