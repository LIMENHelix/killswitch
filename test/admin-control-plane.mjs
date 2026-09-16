// ADMIN CONTROL-PLANE COHERENCE tests (SIMULATED — no real provider, no real send).
//
// The production split-brain: the legacy ks:autopilot panel showed "Mailing
// autopilot ON" while every actual send path (cron-mail, run-autopilot, mail)
// already executed through the armed K6 control plane — so the owner saw an ON
// switch whose buttons all failed with outreach_not_armed. The legacy config
// had NO sender left. These tests pin the repair:
//
//   - the legacy blob is served read-only as history (viewing never mutates)
//   - setconfig is retired: 409, nothing written, rep still 403
//   - an armed LEGACY switch cannot bypass K6: unarmed K6 = zero provider calls
//     from every owner send action
//   - armed K6: mail selection sends once; a duplicate click sends nothing
//   - operator E2E on drafted inventory: readiness -> run -> accepted effect,
//     repeat run = no second provider call, draft never published
//   - historical mailed/queued counters survive untouched

process.env.KV_REST_API_URL = 'https://kv.adminplane.test';
process.env.KV_REST_API_TOKEN = 'token';
process.env.ADMIN_KEY = 'owner-key';
process.env.REP_KEYS = 'dana:r_dana_key';
process.env.LOB_API_KEY = 'test_lob_key';
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
    lobCalls.push({ idempotency: options.headers && options.headers['Idempotency-Key'], body: String(options.body || '') });
    return { ok: true, status: 200, json: async () => ({ id: 'psc_sim_' + lobCalls.length }) };
  }
  return kvFetch(url, options);
};

const admin = (await import('../api/admin.js')).default;
const { CFG_KEY } = await import('../lib/k6-outreach.js');
const { getStatusCounts, STATUS } = await import('../lib/outreach-effects.js');
const { upsertSite, getSite } = await import('../lib/sites.js');

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
async function call(action, token, extra = {}) {
  const res = mkres();
  await admin({ method: 'POST', headers: {}, body: { action, token, ...extra } }, res);
  return res;
}

const LEGACY_ARMED = {
  enabled: true, dailyCap: 25, budgetCeiling: 500,
  mailedToday: 3, dayStamp: '2026-09-01', lastRun: { mailed: 3, when: '2026-09-01T14:00:00.000Z' },
};
const K6_ARMED = {
  enabled: true, mode: 'test', channels: ['postcard'],
  perRunCap: 5, dailyCap: 10, lifetimeCap: 20, perRunSpendCap: 1000, dailySpendCap: 2000,
  postcardReserveCents: 94,
};
const LEAD = {
  id: 'L1', name: 'Plane Auto', trade: 'auto repair', phone: '913-555-0100',
  street: '1 Main St', city: 'Kansas City', state: 'MO', zip: '64108',
};
const MAILED_LEAD = {
  id: 'L0', name: 'History Muffler', trade: 'auto repair', phone: '913-555-0199',
  street: '2 Main St', city: 'Kansas City', state: 'MO', zip: '64108',
  status: 'mailed', lob_id: 'psc_historical_1',
};

function reset() { KV.clear(); EXP.clear(); lobCalls = []; }

// ---------------------------------------------------------------------------
console.log('\nLEGACY CONFIG: READ-ONLY HISTORY, WRITES RETIRED');
reset();
KV.set('ks:autopilot', JSON.stringify(LEGACY_ARMED));
const before = KV.get('ks:autopilot');

let r = await call('config', 'owner-key');
check('config still serves the stored legacy blob', r.code === 200 && r.body.config.enabled === true && r.body.config.budgetCeiling === 500);
check('config is labelled as superseded by K6', r.body.supersededBy === 'k6-outreach');
check('viewing admin never mutates the legacy blob', KV.get('ks:autopilot') === before);

r = await call('setconfig', 'owner-key', { enabled: false, dailyCap: 0, budgetCeiling: 0 });
check('setconfig is retired with 409', r.code === 409 && r.body.error === 'legacy_autopilot_superseded', 'got ' + r.code + ' ' + JSON.stringify(r.body));
check('the retired write stored nothing', KV.get('ks:autopilot') === before);

r = await call('setconfig', 'owner-key', { enabled: true, dailyCap: 100, budgetCeiling: 9999 });
check('even a full legacy arming attempt is refused', r.code === 409 && r.body.error === 'legacy_autopilot_superseded');
check('and still stored nothing', KV.get('ks:autopilot') === before);

r = await call('setconfig', 'r_dana_key', { enabled: true });
check('a rep is still refused at the role gate first', r.code === 403 && r.body.error === 'forbidden');

// ---------------------------------------------------------------------------
console.log('\nLEGACY SWITCH CANNOT BYPASS K6 (the split-brain regression)');
reset();
KV.set('ks:autopilot', JSON.stringify(LEGACY_ARMED));   // legacy panel would show ON
KV.set('ks:leads', JSON.stringify([MAILED_LEAD, LEAD]));

r = await call('mail', 'owner-key', { ids: ['L1'] });
check('Approve & mail with legacy ON but K6 unarmed: 409, not a send', r.code === 409 && r.body.error === 'outreach_not_armed', 'got ' + r.code);
check('zero provider calls from the mail action', lobCalls.length === 0);

r = await call('run-autopilot', 'owner-key');
check('run-autopilot with legacy ON but K6 unarmed: 409, not a send', r.code === 409 && r.body.error === 'outreach_not_armed');
check('zero provider calls from run-autopilot', lobCalls.length === 0);

r = await call('list', 'owner-key');
const l0 = r.body.leads.find((x) => x.id === 'L0');
check('historical mailed lead survives intact on the board', !!l0 && l0.status === 'mailed' && l0.lob_id === 'psc_historical_1');
const l1 = r.body.leads.find((x) => x.id === 'L1');
check('the queued lead was not marked mailed by any of that', !!l1 && l1.status !== 'mailed' && !l1.lob_id);

// ---------------------------------------------------------------------------
console.log('\nARMED K6: ONE SEND, DUPLICATE CLICK = ONE EFFECT (SIMULATED)');
reset();
KV.set(CFG_KEY, JSON.stringify(K6_ARMED));
KV.set('ks:leads', JSON.stringify([MAILED_LEAD, LEAD]));

r = await call('outreach-status', 'owner-key');
check('outreach-status reports armed with the owner reserve', r.code === 200 && r.body.armed === true && r.body.config.postcardReserveCents === 94);

r = await call('mail', 'owner-key', { ids: ['L1'] });
check('Approve & mail selected sends the one eligible lead', r.code === 200 && r.body.k6 === true && r.body.sent === 1, JSON.stringify(r.body));
check('exactly one provider invocation', lobCalls.length === 1);
check('with a durable Idempotency-Key', typeof lobCalls[0].idempotency === 'string' && lobCalls[0].idempotency.startsWith('oe-'));

r = await call('mail', 'owner-key', { ids: ['L1'] });
check('an immediate duplicate click sends nothing new', r.code === 200 && r.body.sent === 0);
check('still exactly one provider invocation', lobCalls.length === 1);

r = await call('run-outreach', 'owner-key');
check('a follow-up batch run also sends nothing new', r.code === 200 && r.body.sent === 0);
check('provider total is still one', lobCalls.length === 1);
const counts = await getStatusCounts();
check('the ledger holds exactly one accepted effect', counts[STATUS.ACCEPTED] === 1);

// ---------------------------------------------------------------------------
console.log('\nOPERATOR E2E ON DRAFTED INVENTORY (SIMULATED PROVIDER)');
reset();
KV.set(CFG_KEY, JSON.stringify(K6_ARMED));
// K4/K5 output state: a ranked candidate with its unpublished draft site.
KV.set('ks:disc:cands', {
  'plc-plane-1': JSON.stringify({
    placeId: 'plc-plane-1', name: 'Drafted Dental', category: 'dentist', status: 'ranked', score: 88,
    street: '9 Elm St', city: 'Kansas City', state: 'MO', zip: '64111',
    phone: '816-555-0100', hours: [], draftStatus: 'drafted', draftSlug: 'drafted-dental',
  }),
});
await upsertSite({
  slug: 'drafted-dental', business: 'Drafted Dental', city: 'Kansas City', state: 'MO',
  phone: '816-555-0100', street: '9 Elm St', zip: '64111',
  modules: ['P0'], published: false, claimed: false, placeId: 'plc-plane-1',
});

r = await call('outreach-readiness', 'owner-key');
const rd = r.body.readiness || {};
check('readiness sees the drafted mailable prospect as eligible',
  r.code === 200 && rd.candidates && rd.candidates.total === 1 && rd.candidates.drafted === 1 && rd.candidates.draftedMailable === 1 && rd.candidates.eligible === 1,
  JSON.stringify(rd.candidates));
check('readiness reports provider mode and reserve without secrets', rd.providerMode === 'TEST' && rd.postcardReserve && rd.postcardReserve.configured === true && rd.postcardReserve.cents === 94);
check('readiness carries no prospect PII', !JSON.stringify(rd).includes('Drafted Dental') && !JSON.stringify(rd).includes('816-555') && !JSON.stringify(rd).includes('Elm St'));

r = await call('run-outreach', 'owner-key');
check('the operator batch sends the eligible drafted prospect', r.code === 200 && r.body.sent === 1, JSON.stringify(r.body));
check('one provider invocation for the drafted prospect', lobCalls.length === 1);
check('the card carries no draft link (K5 boundary)', !lobCalls[0].body.includes('drafted-dental'));
const draftSite = await getSite('drafted-dental');
check('the draft stays unpublished after outreach', draftSite && draftSite.published === false);

r = await call('run-outreach', 'owner-key');
check('repeating the batch sends nothing new', r.code === 200 && r.body.sent === 0 && lobCalls.length === 1);

r = await call('outreach-readiness', 'owner-key');
check('readiness then shows the accepted effect', r.body.readiness && r.body.readiness.effectsByStatus && r.body.readiness.effectsByStatus[STATUS.ACCEPTED] === 1);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
clearKvStub();
process.exit(fail ? 1 : 0);
