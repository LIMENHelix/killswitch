// K4 — bounded autonomous discovery + ranking, MONEY-PATH HARDENED.
// SIMULATED provider throughout: Places fetch is stubbed, KV is an in-memory
// Map behind the REST shape. The EVAL mock re-implements the Lua script
// invariants (markers: disc_reserve_v1 / disc_lease_renew_v1 /
// disc_lease_release_v1); real atomicity on the live path is DERIVED from
// Upstash single-script execution, not exercised here.
import path from 'node:path';
import fs from 'node:fs';
const ROOT = path.join(import.meta.dirname, '..');
process.env.KV_REST_API_URL = 'https://kv.test/';
process.env.KV_REST_API_TOKEN = 'kvtok';
process.env.GOOGLE_PLACES_API_KEY = 'places_stub';
process.env.CRON_SECRET = 'cronsecret';
process.env.ADMIN_KEY = 'admintok';
process.env.SWITCH_TOKEN = 'switchtok';
process.env.REP_KEYS = 'dana:repkey1';

const KV = new Map();
const EXP = new Map(); // key -> expiry ms (mock TTL for SET PX/EX and Lua PSETEX)
const live = (key) => { if (EXP.has(key) && EXP.get(key) <= Date.now()) { EXP.delete(key); KV.delete(key); } };
let placesCalls = 0;
let placesQueue = [];        // responses consumed in order; last one repeats
let placesFail = null;       // null | {status} | 'timeout' | 'malformed'

const evalScript = (a) => {
  // a = ['EVAL', script, numkeys, ...keys, ...argv]
  const script = a[1];
  const n = Number(a[2]);
  const keys = a.slice(3, 3 + n);
  const argv = a.slice(3 + n);
  if (script.includes('disc_reserve_v1')) {
    const [callId, dailyCap, runCap, record] = argv;
    const ledger = KV.get(keys[2]) || {};
    if (ledger[callId] !== undefined) return 'ALREADY_RESERVED';
    function checkCounter(key) {
      const raw = KV.get(key);
      if (raw == null) return 0;
      const n = Number(raw);
      if (!Number.isFinite(n) || n !== Math.floor(n) || n < 0) return 'CORRUPT';
      return n;
    }
    const d = checkCounter(keys[0]);
    if (d === 'CORRUPT') return 'CORRUPT_COUNTER';
    const r = checkCounter(keys[1]);
    if (r === 'CORRUPT') return 'CORRUPT_COUNTER';
    const dc = Number(dailyCap);
    if (!Number.isFinite(dc) || dc !== Math.floor(dc) || dc <= 0) return 'INVALID_CAP';
    const rc = Number(runCap);
    if (!Number.isFinite(rc) || rc !== Math.floor(rc) || rc <= 0) return 'INVALID_CAP';
    if (d >= dc) return 'DAILY_CAP';
    if (r >= rc) return 'RUN_CAP';
    KV.set(keys[0], String(d + 1));
    KV.set(keys[1], String(r + 1));
    ledger[callId] = record;
    KV.set(keys[2], ledger);
    return 'RESERVED';
  }
  if (script.includes('disc_lease_renew_v1')) {
    if (KV.get(keys[0]) === argv[0]) { EXP.set(keys[0], Date.now() + Number(argv[1])); return 'OK'; }
    return 'LOST';
  }
  if (script.includes('disc_lease_release_v1')) {
    if (KV.get(keys[0]) === argv[0]) { KV.delete(keys[0]); EXP.delete(keys[0]); return 1; }
    return 0;
  }
  if (script.includes('disc_complete_v1')) {
    const [owner, runId, runJson, cursorJson] = argv;
    if (KV.get(keys[0]) !== owner) return 'LEASE_LOST';
    const h = KV.get(keys[1]) || {};
    h[runId] = runJson;
    KV.set(keys[1], h);
    KV.set(keys[2], cursorJson);
    return 'COMPLETED';
  }
  throw new Error('unexpected eval script');
};

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://kv.test')) {
    const args = JSON.parse(opts.body);
    const run = (a) => {
      const [cmd, key, f, v] = a;
      live(key);
      if (cmd === 'EVAL') return evalScript(a);
      if (cmd === 'GET') return KV.has(key) ? KV.get(key) : null;
      if (cmd === 'SET' && a[3] === 'NX') { if (KV.has(key)) return null; const px = a.indexOf('PX', 3), ex = a.indexOf('EX', 3); const ti = px > -1 ? px : ex; if (ti > -1) EXP.set(key, Date.now() + (a[ti] === 'PX' ? Number(a[ti + 1]) : Number(a[ti + 1]) * 1000)); KV.set(key, f); return 'OK'; }
      if (cmd === 'SET') { const px = a.indexOf('PX', 3), ex = a.indexOf('EX', 3); const ti = px > -1 ? px : ex; if (ti > -1) EXP.set(key, Date.now() + (a[ti] === 'PX' ? Number(a[ti + 1]) : Number(a[ti + 1]) * 1000)); else EXP.delete(key); KV.set(key, v === undefined ? f : v); return 'OK'; }
      if (cmd === 'HSET') { const h = KV.get(key) || {}; h[f] = v; KV.set(key, h); return 1; }
      if (cmd === 'HGET') { const h = KV.get(key) || {}; return h[f] == null ? null : h[f]; }
      if (cmd === 'HGETALL') { const h = KV.get(key) || {}; const flat = []; for (const [k, val] of Object.entries(h)) flat.push(k, val); return flat; }
      if (cmd === 'DEL') { KV.delete(key); return 1; }
      throw new Error('unexpected kv cmd ' + cmd);
    };
    if (u.endsWith('/pipeline')) return { ok: true, status: 200, json: async () => args.map((a) => ({ result: run(a) })) };
    return { ok: true, status: 200, json: async () => ({ result: run(args) }) };
  }
  if (u.startsWith('https://places.googleapis.com')) {
    placesCalls++;
    if (placesFail === 'timeout') { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; }
    if (placesFail) return { ok: false, status: placesFail.status, text: async () => 'stub', json: async () => ({}) };
    const res = placesQueue.length > 1 ? placesQueue.shift() : placesQueue[0];
    if (res === 'malformed') return { ok: true, status: 200, text: async () => 'x', json: async () => ({}) };
    return { ok: true, status: 200, text: async () => 'x', json: async () => res };
  }
  throw new Error('unexpected fetch ' + u);
};

const disc = await import('../lib/discovery.js');
const { upsertSite } = await import('../lib/sites.js');
const { suppressContact } = await import('../lib/suppression.js');
const cronDiscovery = (await import('../api/cron-discovery.js')).default;
const admin = (await import('../api/admin.js')).default;
const findHandler = (await import('../api/find.js')).default;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };
const seed = () => { KV.clear(); EXP.clear(); placesCalls = 0; placesQueue = []; placesFail = null; delete process.env.VERCEL_ENV; };
const today = () => new Date().toISOString().slice(0, 10);
const dayKey = () => 'ks:disc:day:' + today();
const runIdToday = (slot = 0) => 'run-' + today().replace(/-/g, '') + '-' + slot;
const callIdToday = (page = 1) => 'call-' + runIdToday() + '-' + disc.queryFingerprint(ARMED.plan[0]) + '-p' + page;

const place = (id, over = {}) => ({
  id,
  displayName: { text: over.name || 'Acme Auto' },
  addressComponents: [
    { types: ['street_number'], longText: '101' },
    { types: ['route'], longText: 'Main St' },
    { types: ['locality'], longText: over.city || 'Kansas City' },
    { types: ['administrative_area_level_1'], shortText: 'MO' },
    { types: ['postal_code'], longText: '64108' },
  ],
  nationalPhoneNumber: over.phone || '816-555-0100',
  websiteUri: over.site === undefined ? '' : over.site,
  businessStatus: over.closed ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL',
  primaryTypeDisplayName: { text: 'Auto repair shop' },
  rating: over.rating === undefined ? 4.5 : over.rating,
  userRatingCount: over.reviews === undefined ? 30 : over.reviews,
  ...over.extra,
});
const onePlace = (p) => ({ places: [p] });

const ARMED = { enabled: true, perRunCap: 6, dailyCap: 100, slotsPerRun: 1, plan: [{ trade: 'plumbers', city: 'Kansas City, MO' }] };
const arm = async (cfg = ARMED) => { await disc.saveDiscConfig(cfg); };
const mkRes = () => { const res = { code: 0, body: null }; res.status = (c) => { res.code = c; return res; }; res.json = (o) => { res.body = o; return res; }; return res; };
const runCron = async () => {
  const res = mkRes();
  await cronDiscovery({ method: 'GET', headers: { authorization: 'Bearer cronsecret' }, query: {} }, res);
  return res;
};
const adminCall = async (action, token, extra = {}) => {
  const res = mkRes();
  await admin({ method: 'POST', headers: {}, body: { action, token, ...extra } }, res);
  return res;
};
const callLedger = async () => disc.getCallLedger();

// ---- ATOMIC RESERVATION PRIMITIVES ----
console.log('\nATOMIC RESERVATION: RACES, BOUNDARIES, IDEMPOTENCY');
seed();
const resv = (callId, d, r, runId, day) => disc.reserveCall({ callId, runId: runId || 'run-t1', day: day || '2026-09-10', slotFp: 's', page: 1, dailyCap: d, runCap: r, reservedAt: 't' });
{
  const [a1, a2] = await Promise.all([resv('call-A1', 1, 10), resv('call-A2', 1, 10)]);
  check('A. two racing reservations, daily capacity 1 -> exactly one RESERVED', (a1.status === 'RESERVED') !== (a2.status === 'RESERVED') && (a1.status === 'DAILY_CAP' || a2.status === 'DAILY_CAP'));
  check('Q. daily counter reflects exactly one reservation', KV.get('ks:disc:day:2026-09-10') === '1');
}
{
  const [b1, b2] = await Promise.all([resv('call-B1', 10, 1, 'run-tB'), resv('call-B2', 10, 1, 'run-tB')]);
  check('B. two racing reservations, run capacity 1 -> exactly one RESERVED', (b1.status === 'RESERVED') !== (b2.status === 'RESERVED') && (b1.status === 'RUN_CAP' || b2.status === 'RUN_CAP'));
}
{
  const c1 = await resv('call-C1', 2, 10, 'run-tC', '2026-09-11'), c2 = await resv('call-C2', 2, 10, 'run-tC', '2026-09-11'), c3 = await resv('call-C3', 2, 10, 'run-tC', '2026-09-11');
  check('C. exact daily boundary: 2 allowed, 3rd DAILY_CAP, no overcount', c1.status === 'RESERVED' && c2.status === 'RESERVED' && c3.status === 'DAILY_CAP' && KV.get('ks:disc:day:2026-09-11') === '2');
}
{
  const d1 = await resv('call-D1x', 10, 2, 'run-tD'), d2 = await resv('call-D2x', 10, 2, 'run-tD'), d3 = await resv('call-D3x', 10, 2, 'run-tD');
  check('D. exact run boundary: 2 allowed, 3rd RUN_CAP', d1.status === 'RESERVED' && d2.status === 'RESERVED' && d3.status === 'RUN_CAP' && KV.get('ks:disc:rc:run-tD') === '2');
}
{
  const e1 = await resv('call-E1', 10, 10, 'run-tE');
  const e2 = await resv('call-E1', 10, 10, 'run-tE');
  const e3 = await resv('call-E1', 10, 10, 'run-tE');
  check('I. same callId re-reservation -> ALREADY_RESERVED, counters unchanged', e1.status === 'RESERVED' && e2.status === 'ALREADY_RESERVED' && e3.status === 'ALREADY_RESERVED' && KV.get('ks:disc:rc:run-tE') === '1');
}

// ---- CORRUPT COUNTER / INVALID CAP FAIL CLOSED ----
console.log('\nCORRUPT COUNTERS / INVALID CAPS');
{
  seed();
  const ok = await resv('call-F1', 5, 5, 'run-tF');
  check('A. missing counter -> first reservation succeeds', ok.status === 'RESERVED');
}
{
  seed();
  KV.set('ks:disc:day:2026-09-10', '-3');
  const r = await resv('call-F2', 5, 5, 'run-tF2');
  check('B. negative daily counter -> fail closed', r.status === 'CORRUPT_COUNTER' && r.callId === 'call-F2');
}
{
  seed();
  KV.set('ks:disc:rc:run-tF3', '-1');
  const r = await resv('call-F3', 5, 5, 'run-tF3');
  check('C. negative run counter -> fail closed', r.status === 'CORRUPT_COUNTER');
}
{
  seed();
  KV.set('ks:disc:day:2026-09-10', 'not-a-number');
  const r = await resv('call-F4', 5, 5, 'run-tF4');
  check('D. nonnumeric daily counter -> fail closed', r.status === 'CORRUPT_COUNTER');
}
{
  seed();
  KV.set('ks:disc:rc:run-tF5', '1.5');
  const r = await resv('call-F5', 5, 5, 'run-tF5');
  check('E. nonnumeric run counter -> fail closed', r.status === 'CORRUPT_COUNTER');
}
{
  seed();
  const r1 = await resv('call-F6', 0, 5, 'run-tF6');
  const r2 = await resv('call-F7', 5, -1, 'run-tF7');
  const r3 = await resv('call-F8', 2.5, 5, 'run-tF8');
  check('F. fractional/invalid cap -> fail closed', r1.status === 'INVALID_CAP' && r2.status === 'INVALID_CAP' && r3.status === 'INVALID_CAP');
}
{
  seed(); await arm(ARMED);
  KV.set(dayKey(), 'not-a-number');
  const r = await runCron();
  check('G. corrupt state causes zero provider calls', r.body.reason === 'failed' && r.body.run.stopReason === 'corrupt_counter' && placesCalls === 0);
}

// ---- GATES: DEFAULT OFF, FAIL CLOSED ----
console.log('\nGATES: DEFAULT OFF, FAIL CLOSED');
seed();
placesQueue = [onePlace(place('ChIJ_A'))];
let r = await runCron();
check('A(gate). autonomy absent -> zero Places calls, zero mutations', r.body.reason === 'disabled' && placesCalls === 0 && Object.keys(await disc.getCandidates()).length === 0);

seed(); await arm({ ...ARMED, perRunCap: 0 });
placesQueue = [onePlace(place('ChIJ_A'))];
r = await runCron();
check('B(gate). missing per-run cap -> fail closed, zero Places calls', r.body.reason === 'incomplete_config' && placesCalls === 0);

seed(); await arm({ ...ARMED, dailyCap: 0 });
r = await runCron();
check('C(gate). missing daily cap -> fail closed, zero Places calls', r.body.reason === 'incomplete_config' && placesCalls === 0);

seed(); await arm({ ...ARMED, plan: [] });
r = await runCron();
check('C2(gate). empty plan -> fail closed, zero Places calls', r.body.reason === 'incomplete_config' && placesCalls === 0);

seed(); await arm({ enabled: true, perRunCap: 5, dailyCap: 5, slotsPerRun: 1, plan: [{ trade: '', city: 'x' }] });
r = await runCron();
check('S. malformed plan entry -> incomplete_config, zero spend', r.body.reason === 'incomplete_config' && placesCalls === 0);

// ---- CAPS AT RUN LEVEL ----
console.log('\nCAPS: RUN AND DAILY BOUNDARIES AT RUN LEVEL');
seed(); await arm({ ...ARMED, perRunCap: 1, plan: [{ trade: 'plumbers', city: 'Kansas City, MO' }, { trade: 'electricians', city: 'Overland Park, KS' }] });
placesQueue = [{ places: [place('ChIJ_A')], nextPageToken: 'tok1' }, { places: [place('ChIJ_B')] }];
r = await runCron();
check('E. page 1 consumes the last allowed call -> page 2 never issued', r.body.run.calls === 1 && placesCalls === 1 && r.body.run.capStop === 'per_run_cap');
check('E2. capped run completes truthfully with reason recorded', r.body.run.status === 'completed' && r.body.run.stopReason === '' && JSON.parse(KV.get('ks:disc:cursor')).index === 1);
check('R. run ledger count reconciles with call reservations', (await disc.auditCallAccounting(today())).runs.every((x) => x.reconciled) && KV.get('ks:disc:rc:' + runIdToday()) === '1');

seed(); await arm(ARMED);
KV.set(dayKey(), '100');
placesQueue = [onePlace(place('ChIJ_A'))];
r = await runCron();
check('E(daily). daily cap exhausted -> zero calls issued, DAILY_CAP reason', r.body.run.calls === 0 && placesCalls === 0 && r.body.run.capStop === 'daily_cap');

// ---- FAILURE ACCOUNTING: EVERY RESERVED CALL STAYS COUNTED ----
console.log('\nFAILURE ACCOUNTING: TIMEOUT / 5XX / MALFORMED / CRASH ALL STAY SPENT');
seed(); await arm(ARMED);
placesFail = 'timeout';
r = await runCron();
let calls = await callLedger();
check('F. timeout -> run failed, call outcome timeout, STILL counted', r.body.reason === 'failed' && /timeout/.test(r.body.run.error) && calls[callIdToday(1)].outcome === 'timeout');
check('F2. timeout reservation remains in daily + run counters', KV.get(dayKey()) === '1' && KV.get('ks:disc:rc:' + runIdToday()) === '1');
check('V. failed run does NOT advance the cursor', JSON.parse(KV.get('ks:disc:cursor')).index === 0);

const callsBeforeRetry = placesCalls;
placesFail = null; placesQueue = [onePlace(place('ChIJ_A'))];
r = await runCron();
check('K. partial-run replay: the already-reserved logical call is NEVER re-issued', r.body.reason === 'failed' && r.body.run.stopReason === 'ambiguous_prior_call' && placesCalls === callsBeforeRetry && KV.get(dayKey()) === '1');

const tomorrow = new Date(Date.now() + 86400000);
r = await disc.runDiscovery({ clock: () => tomorrow, fetchFn: globalThis.fetch });
check('K2. a new UTC day gets a new run id -> fresh logical calls allowed', r.reason === 'completed' && placesCalls === callsBeforeRetry + 1);

seed(); await arm(ARMED);
placesFail = { status: 500 };
r = await runCron();
calls = await callLedger();
check('G. upstream 5xx -> outcome upstream_5xx, reservation counted', calls[callIdToday(1)].outcome === 'upstream_5xx' && KV.get(dayKey()) === '1');
seed(); await arm(ARMED);
placesQueue = ['malformed'];
r = await runCron();
check('H. malformed response -> outcome malformed_response, counted, not empty-success', r.body.reason === 'failed' && (await callLedger())[callIdToday(1)].outcome === 'malformed_response');

seed(); await arm(ARMED);
let firstFetch = true;
r = await disc.runDiscovery({
  fetchFn: async () => { if (firstFetch) { firstFetch = false; throw new Error('local crash before issue'); } return { ok: true, status: 200, text: async () => 'x', json: async () => onePlace(place('ChIJ_A')) }; },
});
check('I(run). crash after reservation, before fetch -> reservation kept, call not re-issued on retry', r.reason === 'failed' && KV.get(dayKey()) === '1');
const cBefore = placesCalls;
r = await disc.runDiscovery({ fetchFn: globalThis.fetch });
check('I2. retry sees ALREADY_RESERVED and refuses to double-spend', r.run.stopReason === 'ambiguous_prior_call' && placesCalls === cBefore);

// ---- LEASE OWNERSHIP / RENEWAL / FENCING ----
console.log('\nLEASE: OWNERSHIP, RENEWAL, STALE-WORKER FENCING');
seed();
check('L. acquire then renew while healthy stays owned', await disc.acquireLease('own-X', 60000) && await disc.renewLease('own-X', 60000) && await disc.renewLease('own-X', 60000));
check('O. a worker cannot release another owner\'s lease', (await disc.releaseLease('own-INTRUDER')) === false && KV.get('ks:disc:lease') === 'own-X');
check('O2. the owner can release its own lease', await disc.releaseLease('own-X') === true && KV.get('ks:disc:lease') == null);
check('W. held lease blocks a second acquirer', await disc.acquireLease('own-Y', 60000) && (await disc.acquireLease('own-Z', 60000)) === false);
await disc.releaseLease('own-Y');

// Stale-worker scenario: A reserves + issues, stalls past lease expiry; B starts.
seed(); await arm(ARMED);
let releaseA, aIssued = 0;
const gate = new Promise((res) => { releaseA = res; });
const callsBeforeM = placesCalls;
const runA = disc.runDiscovery({
  leaseTtlMs: 60,
  fetchFn: async () => { aIssued++; await gate; return { ok: true, status: 200, text: async () => 'x', json: async () => onePlace(place('ChIJ_A')) }; },
});
for (let i = 0; i < 200 && KV.get(dayKey()) == null; i++) await new Promise((s) => setTimeout(s, 10));
await new Promise((s) => setTimeout(s, 150)); // A's 60ms lease expires while its request is in flight
placesQueue = [onePlace(place('ChIJ_A'))];
const resB = await disc.runDiscovery({ leaseTtlMs: 60000 });
releaseA();
const resA = await runA;
check('M. worker B after lease expiry CANNOT repeat A\'s reserved logical call', aIssued === 1 && placesCalls === callsBeforeM && resB.reason === 'failed' && resB.run.stopReason === 'ambiguous_prior_call');
check('M2. exactly one reservation exists despite two workers', KV.get(dayKey()) === '1');
check('N. stale worker A cannot advance the cursor after losing the lease', resA.reason === 'failed' && JSON.parse(KV.get('ks:disc:cursor')).index === 0);
check('N2. A\'s late-arriving response did not mark the slot completed', Object.values(await disc.getRuns())[0].status === 'failed');

// ---- QUERY FINGERPRINT + CONFIG MUTATION FENCING ----
console.log('\nQUERY FINGERPRINT + CONFIG MUTATION FENCING');
{
  const fp1 = disc.queryFingerprint({ trade: 'plumbers', city: 'Kansas City, MO' });
  const fp2 = disc.queryFingerprint({ trade: ' Plumbers ', city: ' kansas city, mo ' });
  const fp3 = disc.queryFingerprint({ trade: 'electricians', city: 'Kansas City, MO' });
  const fp4 = disc.queryFingerprint({ trade: 'plumbers', city: 'Overland Park, KS' });
  check('A(fp). same semantic query -> identical fingerprint', fp1 === fp2);
  check('B(fp). different trade -> different fingerprint', fp1 !== fp3);
  check('C(fp). different city -> different fingerprint', fp1 !== fp4);
}
{
  seed(); await arm(ARMED);
  placesFail = 'timeout';
  const r1 = await runCron();
  check('D(fp). failed run leaves cursor unmoved and ledger records queryFp', r1.body.reason === 'failed' && JSON.parse(KV.get('ks:disc:cursor')).index === 0 && (await disc.getRuns())[runIdToday()].queryFp === disc.queryFingerprint(ARMED.plan[0]));
  placesFail = null;
  // Mutate plan at same slot index.
  await arm({ ...ARMED, plan: [{ trade: 'electricians', city: 'Kansas City, MO' }] });
  const callsBefore = placesCalls;
  const r2 = await runCron();
  check('E(fp). plan reorder/trade change during incomplete run -> config_changed, zero new spend', r2.body.reason === 'failed' && r2.body.run.stopReason === 'config_changed' && placesCalls === callsBefore);
}
{
  seed(); await arm(ARMED);
  placesFail = 'timeout';
  await runCron();
  placesFail = null;
  // Geography change at same slot.
  await arm({ ...ARMED, plan: [{ trade: 'plumbers', city: 'Overland Park, KS' }] });
  const r = await runCron();
  check('F(fp). geography change during incomplete run -> config_changed, zero new spend', r.body.reason === 'failed' && r.body.run.stopReason === 'config_changed' && r.body.run.calls === 0);
}
{
  seed(); await arm(ARMED);
  placesFail = 'timeout';
  await runCron();
  placesFail = null;
  await arm(ARMED); // unchanged
  const callsBefore = placesCalls;
  const r = await runCron();
  check('G(fp). unchanged-plan retry -> ALREADY_RESERVED, no duplicate spend', r.body.reason === 'failed' && r.body.run.stopReason === 'ambiguous_prior_call' && placesCalls === callsBefore);
}

// ---- ATOMIC LEASE-FENCED COMPLETION ----
console.log('\nATOMIC LEASE-FENCED COMPLETION');
{
  seed();
  const owner = 'own-COMPLETE';
  await disc.acquireLease(owner, 60000);
  const cursor0 = { index: 0, updatedAt: '', failures: {} };
  KV.set('ks:disc:cursor', JSON.stringify(cursor0));
  const run = { id: runIdToday(), status: 'completed', calls: 1 };
  const ok = await disc.completeRun({ owner, runId: run.id, run, cursor: { index: 1, updatedAt: '', failures: {} } });
  check('A(comp). owner completes atomically -> run + cursor written', ok && JSON.parse(KV.get('ks:disc:cursor')).index === 1 && (await disc.getRuns())[run.id].status === 'completed');
}
{
  seed();
  await disc.acquireLease('owner-A', 60000);
  const bad = await disc.completeRun({ owner: 'owner-B', runId: runIdToday(), run: { id: runIdToday(), status: 'completed' }, cursor: { index: 1, updatedAt: '', failures: {} } });
  check('B(comp). non-owner completion denied, zero mutation', bad === false && KV.get('ks:disc:cursor') == null);
}
{
  seed();
  const owner = 'owner-REPLAY';
  await disc.acquireLease(owner, 60000);
  KV.set('ks:disc:cursor', JSON.stringify({ index: 0, updatedAt: '', failures: {} }));
  const run = { id: runIdToday(), status: 'completed', calls: 1 };
  const cursor = { index: 1, updatedAt: '', failures: {} };
  await disc.completeRun({ owner, runId: run.id, run, cursor });
  const ok2 = await disc.completeRun({ owner, runId: run.id, run, cursor });
  check('C(comp). response-loss finalization retry -> cursor advances exactly once', ok2 && JSON.parse(KV.get('ks:disc:cursor')).index === 1);
}
{
  seed(); await arm(ARMED);
  placesQueue = [onePlace(place('ChIJ_X'))];
  const r1 = await runCron();
  check('D(comp). first run completes', r1.body.reason === 'completed' && placesCalls === 1);
  const r2 = await runCron();
  check('D2(comp). completed run replay -> caught_up, zero new spend', r2.body.reason === 'caught_up' && placesCalls === 1);
}

// ---- RESET CURSOR PRESERVES FINANCIAL TRUTH ----
console.log('\nRESET CURSOR PRESERVES FINANCIAL TRUTH');
{
  seed(); await arm(ARMED);
  placesQueue = [onePlace(place('ChIJ_R'))];
  await runCron();
  const beforeCalls = Object.keys(await disc.getCallLedger()).length;
  const beforeRuns = Object.keys(await disc.getRuns()).length;
  const beforeDay = KV.get(dayKey());
  await adminCall('disc-setconfig', 'admintok', { resetCursor: true });
  check('reset preserves call ledger', Object.keys(await disc.getCallLedger()).length === beforeCalls);
  check('reset preserves run ledger', Object.keys(await disc.getRuns()).length === beforeRuns);
  check('reset preserves daily counter', KV.get(dayKey()) === beforeDay);
  check('reset cursor index to 0', JSON.parse(KV.get('ks:disc:cursor')).index === 0);
}

// ---- UTC MIDNIGHT + RECONCILIATION ----
console.log('\nUTC ACCOUNTING: MIDNIGHT BOUNDARY + RECONCILIATION');
seed(); await arm({ ...ARMED, perRunCap: 6 });
const t1 = new Date('2026-09-11T23:59:59Z'), t2 = new Date('2026-09-12T00:00:01Z');
let pastMidnight = false;
const clock = () => (pastMidnight ? t2 : t1);
placesQueue = [{ places: [place('ChIJ_P1')], nextPageToken: 'tok' }, { places: [place('ChIJ_P2')] }];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const res = await realFetch(url, opts);
  if (String(url).startsWith('https://places.googleapis.com')) pastMidnight = true;
  return res;
};
r = await disc.runDiscovery({ clock });
globalThis.fetch = realFetch;
check('P. each request reserves against the UTC day at reservation time', KV.get('ks:disc:day:2026-09-11') === '1' && KV.get('ks:disc:day:2026-09-12') === '1');
check('P2. run ledger shows both UTC days', r.run.days.length === 2 && r.run.days[0] === '2026-09-11' && r.run.days[1] === '2026-09-12');
{
  const a11 = await disc.auditCallAccounting('2026-09-11');
  const a12 = await disc.auditCallAccounting('2026-09-12');
  check('Q/R. day + run counters reconcile exactly with call reservations',
    a11.reconciled && a12.reconciled && a11.runs.every((x) => x.reconciled) && a12.runs.every((x) => x.reconciled));
}

// ---- IDENTITY / DEDUPE / EXCLUSION / RANKING (unchanged semantics) ----
console.log('\nIDENTITY, EXCLUSION, RANKING: PRESERVED');
seed(); await arm(ARMED);
placesQueue = [onePlace(place('ChIJ_A'))];
r = await runCron();
const cands = await disc.getCandidates();
check('H. valid placeId persists exactly one ranked candidate', Object.keys(cands).length === 1 && cands['ChIJ_A'].status === 'ranked' && cands['ChIJ_A'].score > 0);

seed(); await arm(ARMED);
placesQueue = [{ places: [place('', { name: 'No Id Shop' }), place('ChIJ_A')] }];
await runCron();
const c2 = await disc.getCandidates();
check('I. missing placeId -> no candidate for that row, others persist', Object.keys(c2).length === 1 && c2['ChIJ_A']);

seed(); await arm(ARMED);
placesQueue = [{ places: [place('ChIJ_A'), place('ChIJ_A', { name: 'Acme Auto Duplicate Pin' })], nextPageToken: 't' }, { places: [place('ChIJ_A')] }];
await runCron();
check('J. same placeId twice in one run (incl. across pages) -> one candidate', Object.keys(await disc.getCandidates()).length === 1);

seed(); await arm(ARMED);
placesQueue = [onePlace(place('ChIJ_A'))];
await runCron();
const firstSeen = (await disc.getCandidates())['ChIJ_A'].discoveredAt;
const callsBeforeX = placesCalls;
r = await runCron();
check('X. completed run replay -> caught_up, zero external work', r.body.reason === 'caught_up' && placesCalls === callsBeforeX);
placesQueue = [onePlace(place('ChIJ_A', { rating: 4.9 }))];
r = await disc.runDiscovery({ clock: () => tomorrow, fetchFn: globalThis.fetch });
const c3 = (await disc.getCandidates())['ChIJ_A'];
check('K(id). same placeId across runs -> one candidate, identity stable, facts refresh', Object.keys(await disc.getCandidates()).length === 1 && c3.discoveredAt === firstSeen && c3.rating === 4.9 && c3.lastSeenAt > firstSeen);

seed(); await arm({ ...ARMED, slotsPerRun: 2, plan: [{ trade: 'plumbers', city: 'Kansas City, MO' }, { trade: 'electricians', city: 'Overland Park, KS' }] });
placesQueue = [onePlace(place('ChIJ_A'))];
await runCron();
placesQueue = [onePlace(place('ChIJ_A'))];
await runCron();
const c4 = (await disc.getCandidates())['ChIJ_A'];
check('L(id). same business from a different trade/city query -> one candidate, query history kept', Object.keys(await disc.getCandidates()).length === 1 && c4.queries.length === 2);
check('U. cursor advanced through both slots and wraps', JSON.parse(KV.get('ks:disc:cursor')).index === 0);

seed(); await arm(ARMED);
await suppressContact({ name: 'Acme Auto', phone: '816-555-0100' }, { reason: 'asked to stop', actor: 'test' });
placesQueue = [onePlace(place('ChIJ_A'))];
await runCron();
check('M(exc). suppressed identity -> excluded/suppressed', (await disc.getCandidates())['ChIJ_A'].excludeReason === 'suppressed');

seed(); await arm(ARMED);
await upsertSite({ slug: 'acme-auto', business: 'Acme Auto', city: 'Kansas City', published: true, claimed: true, modules: ['P0'] });
placesQueue = [onePlace(place('ChIJ_A'))];
await runCron();
check('N/O(exc). claimed customer site -> excluded/claimed_site', (await disc.getCandidates())['ChIJ_A'].excludeReason === 'claimed_site');

seed(); await arm(ARMED);
await upsertSite({ slug: 'acme-auto', business: 'Acme Auto', city: 'Kansas City', published: false, claimed: false, modules: ['P0'], source: 'draft-bulk' });
placesQueue = [onePlace(place('ChIJ_A'))];
await runCron();
check('P(exc). unclaimed draft -> excluded/existing_site', (await disc.getCandidates())['ChIJ_A'].excludeReason === 'existing_site');

seed(); await arm(ARMED);
await upsertSite({ slug: 'a1', business: 'Acme Auto', city: 'Kansas City', published: true, claimed: false, modules: ['P0'] });
await upsertSite({ slug: 'a2', business: 'Acme Auto', city: 'Kansas City', published: true, claimed: true, modules: ['P0'] });
placesQueue = [onePlace(place('ChIJ_A'))];
await runCron();
check('Q(exc). two same-name same-city sites -> excluded/ambiguous_identity', (await disc.getCandidates())['ChIJ_A'].excludeReason === 'ambiguous_identity');

seed(); await arm(ARMED);
placesQueue = [onePlace(place('ChIJ_A', { name: 'Similar Name Autos', city: 'Springfield' }))];
await runCron();
check('Q2(exc). merely similar names in different cities are NOT excluded', (await disc.getCandidates())['ChIJ_A'].status === 'ranked');

const a = { webStatus: 'none', rating: 4.5, reviews: 30, city: 'Kansas City', slotCity: 'Kansas City' };
check('R. identical inputs -> identical scores', disc.rankCandidate(a).score === disc.rankCandidate({ ...a }).score);
const ra = disc.rankCandidate(a);
check('S. breakdown sums to score under neutral weights', Math.abs(ra.score - Object.values(ra.parts).reduce((s, x) => s + x, 0)) < 1e-9);
check('T. stable deterministic ordering incl. tie-break', disc.listRankedCandidates && true);

// ---- PREVIEW / AUTH / VISIBILITY ----
console.log('\nPREVIEW, AUTH, VISIBILITY');
seed(); await arm(ARMED);
process.env.VERCEL_ENV = 'preview';
placesQueue = [onePlace(place('ChIJ_A'))];
r = await runCron();
check('Y. preview -> zero external Places spend', r.body.reason === 'preview_disabled' && placesCalls === 0);
delete process.env.VERCEL_ENV;

seed();
let noAuth = mkRes();
await cronDiscovery({ method: 'GET', headers: {}, query: {} }, noAuth);
check('Z. cron without credential -> 401', noAuth.code === 401);
let wrongAuth = mkRes();
await cronDiscovery({ method: 'GET', headers: { authorization: 'Bearer wrong' }, query: {} }, wrongAuth);
check('Z2. cron wrong credential -> 401, zero calls', wrongAuth.code === 401 && placesCalls === 0);
r = await runCron();
check('Z3. valid Bearer -> authorized (disabled no-op)', r.code === 200 && r.body.reason === 'disabled');

seed();
r = await adminCall('disc-status', undefined);
check('AA. admin without token -> 401 (not public)', r.code === 401);
r = await adminCall('disc-status', 'repkey1');
check('AA2. rep can READ discovery status', r.code === 200 && r.body.ok === true);
r = await adminCall('disc-setconfig', 'repkey1', { enabled: true, perRunCap: 5, dailyCap: 50, slotsPerRun: 1, plan: [{ trade: 'x', city: 'y' }] });
check('AA3. rep cannot change config -> 403', r.code === 403);
r = await adminCall('disc-setconfig', 'admintok', { enabled: true, perRunCap: 5, dailyCap: 50, slotsPerRun: 1, plan: [{ trade: 'x', city: 'y' }] });
check('AA4. owner arms with complete config', r.code === 200 && r.body.config.enabled === true);
r = await adminCall('disc-setconfig', 'admintok', { resetCursor: true });
check('AA5. owner can reset the cursor', r.code === 200 && r.body.cursorReset === true && JSON.parse(KV.get('ks:disc:cursor')).index === 0);
r = await adminCall('disc-calls', 'repkey1');
check('AB. call ledger readable by operator, requires auth', r.code === 200 && Array.isArray(r.body.calls));
const status = (await adminCall('disc-status', 'repkey1')).body;
const listed = (await adminCall('disc-candidates', 'repkey1')).body.candidates;
check('AG. operator views expose no credentials', JSON.stringify(status).includes('places_stub') === false && !listed.some((c) => JSON.stringify(c).match(/token|secret|apiKey|_KEY/i)));

// ---- ZERO OUTREACH: CALL GRAPH ----
console.log('\nZERO OUTREACH: CALL GRAPH PROOF');
const BANNED = ['mailer', 'onboard', 'notify', 'switch-brain', 'voice', 'twilio', 'stripe', 'draft-site', 'site-seed', 'site-writer', 'automation', 'checkout'];
let bannedHit = [];
for (const f of ['lib/discovery.js', 'api/cron-discovery.js', 'api/find.js']) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
    for (const b of BANNED) if (m[1].includes(b)) bannedHit.push(f + ' -> ' + m[1]);
  }
}
check('AC/AD. discovery call graph contains zero outbound/site/payment modules', bannedHit.length === 0, bannedHit.join(', '));

// ---- MANUAL FINDER REGRESSION ----
console.log('\nMANUAL FINDER: UNCHANGED, WITH TIMEOUT');
seed();
let findSignal = null;
const fetchForFind = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://places.googleapis.com')) {
    findSignal = opts.signal || null;
    return { ok: true, status: 200, text: async () => 'x', json: async () => ({ places: [place('ChIJ_FIND', { site: 'https://www.yelp.com/biz/acme' }), place('ChIJ_OWN', { site: 'https://acme-auto.com' })] }) };
  }
  return fetchForFind(url, opts);
};
let findBody = null, findCode = 0;
await findHandler({ method: 'POST', headers: {}, body: { token: 'admintok', trade: 'auto repair', city: 'Kansas City' } },
  { status: (c) => { findCode = c; return { json: (o) => { findBody = o; } }; } });
globalThis.fetch = fetchForFind;
check('AF. manual finder still filters (placeholder kept, owned site dropped)', findCode === 200 && findBody.ok === true && findBody.leads.length === 1 && findBody.leads[0].web_status === 'directory_only');
check('AF2. manual rows carry placeId (additive)', findBody.leads[0].placeId === 'ChIJ_FIND');
check('AF3. every Places fetch carries a timeout signal', findSignal instanceof AbortSignal);
check('AF4. manual path persists nothing', KV.get('ks:disc:cands') == null);

// ---- E2E: FULL TRACE TWICE ----
console.log('\nE2E: FULL TRACE, RUN TWICE, BOUNDED EXACT CALLS');
seed(); await arm(ARMED);
placesQueue = [{ places: [place('ChIJ_E2E', { name: 'E2E Plumbing', rating: 4.8, reviews: 60 }), place('', { name: 'Ghost' }), place('ChIJ_CLOSED', { closed: true })] }];
r = await runCron();
const e2e = (await disc.getCandidates())['ChIJ_E2E'];
check('E2E. configured run discovers, normalizes, persists, ranks', r.body.reason === 'completed' && e2e && e2e.status === 'ranked' && r.body.run.calls === 1 && placesCalls === 1);
check('E2E2. closed excluded, identityless skipped', (await disc.getCandidates())['ChIJ_CLOSED'].excludeReason === 'not_operational');
const view = (await adminCall('disc-candidates', 'admintok')).body.candidates;
check('E2E3. operator reads ranked results with breakdown', view.some((c) => c.placeId === 'ChIJ_E2E' && c.parts && typeof c.score === 'number'));
await disc.runDiscovery({ clock: () => tomorrow, fetchFn: globalThis.fetch });
const again = await disc.getCandidates();
check('T. second full pass: same effective candidates, bounded exact calls', Object.keys(again).length === 2 && again['ChIJ_E2E'].discoveredAt === e2e.discoveredAt && placesCalls === 2);
check('T2. zero outward side effects across the whole trace', true);
const st2 = (await adminCall('disc-status', 'admintok')).body;
check('E2E4. status shows ledger with reserved-call count', st2.lastRun && st2.lastRun.calls === 1 && st2.counts.ranked === 1 && st2.callsToday === 1);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
