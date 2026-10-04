// K6 OPERATOR READINESS + HARD SPEND RESERVATION tests (SIMULATED — no real
// provider). Covers: Lob key-mode prefix classification (key never exposed),
// owner-only readiness auth, a PII/secret-free aggregate payload, legacy
// unarmed backward compatibility, the postcardReserveCents arming gate, and
// reserve-driven atomic spend caps.

process.env.KV_REST_API_URL = 'https://kv.k6ready.test';
process.env.KV_REST_API_TOKEN = 'token';
process.env.KS_FROM_NAME = 'Sunflower Websites';
process.env.KS_FROM_LINE1 = '123 Main St';
process.env.KS_FROM_CITY = 'Kansas City';
process.env.KS_FROM_STATE = 'KS';
process.env.KS_FROM_ZIP = '64108';
process.env.ADMIN_KEY = 'owner-key-test';
process.env.REP_KEYS = 'dana:r_reptest';
delete process.env.VERCEL_ENV;
delete process.env.LOB_API_KEY;

import { setupKvStub, clearKvStub } from './helpers/k6-kv.mjs';

const { KV, EXP } = setupKvStub();

let lobCalls = [];
const kvFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u === 'https://api.lob.com/v1/postcards') {
    lobCalls.push({ idempotency: options.headers && options.headers['Idempotency-Key'] });
    return { ok: true, status: 200, json: async () => ({ id: 'psc_ready_' + lobCalls.length }) };
  }
  return kvFetch(url, options);
};

const { runPostcardOutreach, outreachReadiness, CFG_KEY } = await import('../lib/k6-outreach.js');
const { lobKeyMode, senderConfigPresence } = await import('../lib/mailer.js');
const { getRunEffects, getStatusCounts } = await import('../lib/outreach-effects.js');
const { upsertSite } = await import('../lib/sites.js');
const admin = (await import('../api/admin.js')).default;

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
async function callAdmin(body) {
  const res = mkres();
  await admin({ method: 'POST', headers: {}, body }, res);
  return res;
}

function seed(cfg) {
  KV.clear();
  EXP.clear();
  lobCalls = [];
  if (cfg) KV.set(CFG_KEY, JSON.stringify(cfg));
}

const ARMED = {
  enabled: true, mode: 'test', channels: ['postcard'],
  perRunCap: 5, dailyCap: 10, lifetimeCap: 20, perRunSpendCap: 1000, dailySpendCap: 2000,
  postcardReserveCents: 94,
};

let seq = 0;
async function seedProspect(name, forcedPlaceId) {
  const placeId = forcedPlaceId || 'plc-ready-' + (++seq);
  const phone = '(913) 555-0' + (200 + seq);
  const h = KV.get('ks:disc:cands') || {};
  h[placeId] = JSON.stringify({
    placeId, name, category: 'plumber', status: 'ranked', score: 90,
    street: seq + ' Secret Ln', city: 'Kansas City', state: 'MO', zip: '64108',
    phone, hours: [], draftStatus: 'drafted', draftSlug: placeId,
  });
  KV.set('ks:disc:cands', h);
  await upsertSite({
    slug: placeId, business: name, city: 'Kansas City', state: 'MO', phone,
    street: seq + ' Secret Ln', zip: '64108', modules: ['P0'], published: false, claimed: false, placeId,
  });
  return { placeId, phone };
}

function seedLegacyLeads(leads) {
  KV.set('ks:leads', JSON.stringify(leads));
}

console.log('\nLOB KEY MODE: PREFIX CLASSIFICATION ONLY');
check('unset key is MISSING', lobKeyMode() === 'MISSING');
process.env.LOB_API_KEY = 'test_9f8e7d6c5b';
check('test_ prefix is TEST', lobKeyMode() === 'TEST');
process.env.LOB_API_KEY = 'live_1a2b3c4d5e';
check('live_ prefix is LIVE', lobKeyMode() === 'LIVE');
process.env.LOB_API_KEY = 'weird-opaque-string';
check('an unrecognized prefix is UNRECOGNIZED (fail closed)', lobKeyMode() === 'UNRECOGNIZED');
process.env.LOB_API_KEY = 'test_9f8e7d6c5b';
check('sender presence is booleans, never values',
  JSON.stringify(senderConfigPresence()) === JSON.stringify({ KS_FROM_NAME: true, KS_FROM_LINE1: true, KS_FROM_CITY: true, KS_FROM_STATE: true, KS_FROM_ZIP: true }));

console.log('\nREADINESS AUTH FAILS CLOSED');
seed(ARMED);
check('no token -> 401', (await callAdmin({ action: 'outreach-readiness' })).code === 401);
check('bad token -> 401', (await callAdmin({ action: 'outreach-readiness', token: 'nope' })).code === 401);
check('rep token -> 403 (owner-only)', (await callAdmin({ action: 'outreach-readiness', token: 'r_reptest' })).code === 403);
const okRes = await callAdmin({ action: 'outreach-readiness', token: 'owner-key-test' });
check('owner token -> 200 with readiness', okRes.code === 200 && okRes.body.ok === true && !!okRes.body.readiness);

console.log('\nREADINESS PAYLOAD IS AGGREGATE-ONLY (NO SECRETS, NO PII)');
KV.clear(); EXP.clear();
KV.set(CFG_KEY, JSON.stringify(ARMED));
const pii = await seedProspect('Ready Check Plumbing');
await seedProspect('Second Secret Shop');
const r2 = await callAdmin({ action: 'outreach-readiness', token: 'owner-key-test' });
const payload = JSON.stringify(r2.body);
check('payload never contains the Lob key value', !payload.includes('test_9f8e7d6c5b'));
check('payload contains no business names', !payload.includes('Ready Check Plumbing') && !payload.includes('Second Secret Shop'));
check('payload contains no phone digits', !payload.includes('9135550201') && !payload.includes('913-555'));
check('payload contains no street addresses', !payload.includes('Secret Ln'));
check('payload contains no raw KV keys', !payload.includes('ks:'));
const rd = r2.body.readiness;
check('counts are right', rd.candidates.total === 2 && rd.candidates.ranked === 2 && rd.candidates.drafted === 2
  && rd.candidates.draftedMailable === 2 && rd.eligible === 2, JSON.stringify(rd.candidates));
check('the send pool is the drafted inventory when the legacy queue is empty',
  rd.legacyQueue === 0 && rd.pool === 2 && rd.mailable === 2);
check('provider mode is classified', rd.providerMode === 'TEST');
check('reserve is reported configured with cents', rd.postcardReserve.configured === true && rd.postcardReserve.cents === 94);
check('aggregates by trade and city', rd.eligibleByTrade.plumber === 2 && rd.eligibleByCity['Kansas City, MO'] === 2);

console.log('\nLEGACY UNARMED CONFIG STAYS BACKWARD COMPATIBLE');
// A config stored before postcardReserveCents existed, enabled with all old
// caps valid: it must NOT arm, must NOT call the provider, and must say why.
const LEGACY = {
  enabled: true, mode: 'test', channels: ['postcard'],
  perRunCap: 5, dailyCap: 10, lifetimeCap: 20, perRunSpendCap: 1000, dailySpendCap: 2000,
};
seed(LEGACY);
await seedProspect('Legacy Config Shop');
let r = await runPostcardOutreach({});
check('legacy config without reserve: not armed, zero provider calls', r.ran === false && r.reason === 'not_armed' && lobCalls.length === 0);
const st = await callAdmin({ action: 'outreach-status', token: 'owner-key-test' });
check('the blocker names the missing reserve', st.body.armed === false
  && (st.body.blockers || []).some((b) => b.includes('postcardReserveCents')), JSON.stringify(st.body.blockers));

console.log('\nMISSING RESERVE BLOCKS A LIVE-MODE SEND');
process.env.LOB_API_KEY = 'live_1a2b3c4d5e';
seed(LEGACY);
await seedProspect('Live Mode Shop');
r = await runPostcardOutreach({});
check('LIVE provider + no reserve: zero calls, zero effects, explicit reason',
  lobCalls.length === 0 && r.ran === false && r.reason === 'not_armed'
  && Object.keys(await getStatusCounts()).length === 0);
process.env.LOB_API_KEY = 'test_9f8e7d6c5b';

console.log('\nCONFIGURED RESERVE DRIVES THE ATOMIC SPEND CAP');
seed({ ...ARMED, postcardReserveCents: 150, perRunSpendCap: 150 });
await seedProspect('Reserve Shop One');
await seedProspect('Reserve Shop Two');
r = await runPostcardOutreach({});
check('one card reserved at the configured 150 cents', r.sent === 1 && lobCalls.length === 1);
let effects = (await getRunEffects(r.run.id)).effects;
check('the effect records the reserve amount used', effects.length === 1 && effects[0].costReserved === 150);
check('the second card hit the spend cap boundary exactly', r.run.capStop === 'RUN_SPEND_CAP_REACHED');

seed({ ...ARMED, postcardReserveCents: 150, perRunSpendCap: 300 });
await seedProspect('Boundary Shop One');
await seedProspect('Boundary Shop Two');
r = await runPostcardOutreach({});
check('300 cap admits exactly two 150-cent reservations', r.sent === 2 && lobCalls.length === 2);

console.log('\nREPEAT RUN: ONE EFFECT, ONE SEND');
const reserveRunId = r.run.id;
r = await runPostcardOutreach({});
check('the repeat run gets its own fresh runId', r.run.id !== reserveRunId);
check('second run sends nothing new', r.sent === 0 && lobCalls.length === 2);
effects = (await getRunEffects(reserveRunId)).effects;
check('still exactly two effects and two reservations', effects.length === 2 && (await getRunEffects(reserveRunId)).rc === 2);

// ---------------------------------------------------------------------------
console.log('\nREADINESS REPORTS THE ACTUAL SEND POOL (BOTH SOURCES)');

// Legacy-only inventory: no K4/K5 candidates at all, only the lead queue.
seed(ARMED);
seedLegacyLeads([
  { id: 'leg-1', name: 'Legacy One', trade: 'roofer', street: '1 A St', city: 'Lee\'s Summit', state: 'MO', zip: '64063' },
  { id: 'leg-2', name: 'Legacy Two', trade: 'roofer', street: '2 B St', city: 'Lee\'s Summit', state: 'MO', zip: '64063' },
  { id: 'leg-historical', name: 'Already Mailed', trade: 'roofer', street: '3 C St', city: 'Lee\'s Summit', state: 'MO', zip: '64063', status: 'mailed', lob_id: 'psc_hist' },
]);
r = await callAdmin({ action: 'outreach-readiness', token: 'owner-key-test' });
let rl = r.body.readiness;
check('legacy-only inventory appears in the pool', rl.legacyQueue === 2 && rl.pool === 2 && rl.mailable === 2, JSON.stringify({ legacyQueue: rl.legacyQueue, pool: rl.pool }));
check('already-mailed leads stay historical, not pooled', rl.pool === 2);
check('legacy-only eligibility is counted by trade and city',
  rl.eligible === 2 && rl.eligibleByTrade.roofer === 2 && rl.eligibleByCity['Lee\'s Summit, MO'] === 2, JSON.stringify({ eligible: rl.eligible, byTrade: rl.eligibleByTrade, byCity: rl.eligibleByCity }));
check('legacy-only readiness carries no PII', !JSON.stringify(rl).includes('Legacy One') && !JSON.stringify(rl).includes('A St'));

// Run parity: what readiness calls eligible is what the run considers, and
// with headroom in every cap each eligible prospect sends exactly once.
r = await runPostcardOutreach({});
check('run considers exactly what readiness counted eligible', r.run.eligible === rl.eligible && r.sent === 2 && lobCalls.length === 2,
  JSON.stringify({ runEligible: r.run.eligible, sent: r.sent }));

// Mixed inventory with a DUPLICATE identity: one business present as both a
// legacy queued lead (id = its placeId) and a K5 drafted prospect.
seed(ARMED);
seq++;
seedLegacyLeads([
  { id: 'plc-dup-1', name: 'Duplicate Identity', trade: 'plumber', street: '4 D St', city: 'Kansas City', state: 'MO', zip: '64108' },
  { id: 'leg-solo', name: 'Legacy Solo', trade: 'plumber', street: '5 E St', city: 'Kansas City', state: 'MO', zip: '64108' },
]);
await seedProspect('Duplicate Identity', 'plc-dup-1');   // same identity, drafted side
await seedProspect('Drafted Solo');                      // drafted-only
r = await callAdmin({ action: 'outreach-readiness', token: 'owner-key-test' });
rl = r.body.readiness;
check('a duplicate identity counts once in the pool', rl.legacyQueue === 2 && rl.pool === 3, JSON.stringify({ legacyQueue: rl.legacyQueue, pool: rl.pool }));
check('mixed eligibility totals match the deduped pool', rl.eligible === 3 && rl.eligibleByTrade.plumber === 3);
r = await runPostcardOutreach({});
check('the run sends the deduped pool exactly once each', r.run.eligible === 3 && r.sent === 3 && lobCalls.length === 3,
  JSON.stringify({ eligible: r.run.eligible, sent: r.sent, lob: lobCalls.length }));
r = await runPostcardOutreach({});
check('repeating sends nothing (one effect per identity)', r.sent === 0 && lobCalls.length === 3);

// Unarmed: readiness still reports the pool honestly, and nothing can send.
seed(null);
seedLegacyLeads([{ id: 'leg-x', name: 'Unarmed Lead', trade: 'roofer', street: '6 F St', city: 'Olathe', state: 'KS', zip: '66061' }]);
r = await callAdmin({ action: 'outreach-readiness', token: 'owner-key-test' });
check('unarmed readiness still reports the true pool', r.body.readiness.armed === false && r.body.readiness.pool === 1 && r.body.readiness.eligible === 1);
r = await runPostcardOutreach({});
check('unarmed means zero provider calls', r.ran === false && r.reason === 'not_armed' && lobCalls.length === 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
clearKvStub();
process.exit(fail ? 1 : 0);
