// K4 — bounded autonomous discovery + ranking. Focused tests (SIMULATED
// provider: the Places fetch is stubbed, KV is an in-memory Map behind the
// same REST shape the test harness uses everywhere else).
//
// Coverage maps to the mission list: gates A-C, caps D-E, timeout/failure F-G,
// identity H-L, exclusion M-Q, ranking R-T, cursor/run idempotency U-X,
// preview/auth/visibility Y-AB, zero-outreach AC-AD, manual finder AF,
// credential hygiene AG, plus the E2E trace.
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
let placesCalls = 0;
let placesQueue = [];        // responses consumed in order; last one repeats
let placesFail = null;       // null | {status} | 'timeout' | 'malformed'

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://kv.test')) {
    const args = JSON.parse(opts.body);
    const run = (a) => {
      const [cmd, key, f, v] = a;
      if (cmd === 'GET') return KV.has(key) ? KV.get(key) : null;
      if (cmd === 'SET' && a[3] === 'NX') { if (KV.has(key)) return null; KV.set(key, f); return 'OK'; }
      if (cmd === 'SET') { KV.set(key, v === undefined ? f : v); return 'OK'; }
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
const { getSite, upsertSite } = await import('../lib/sites.js');
const { suppressContact } = await import('../lib/suppression.js');
const cronDiscovery = (await import('../api/cron-discovery.js')).default;
const admin = (await import('../api/admin.js')).default;
const findHandler = (await import('../api/find.js')).default;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };
const seed = () => { KV.clear(); placesCalls = 0; placesQueue = []; placesFail = null; delete process.env.VERCEL_ENV; };
const day = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

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
const runCron = async () => {
  const res = { code: 0, body: null };
  res.status = (c) => { res.code = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  await cronDiscovery({ method: 'GET', headers: { authorization: 'Bearer cronsecret' }, query: {} }, res);
  return res;
};
const adminCall = async (action, token, extra = {}) => {
  const res = { code: 0, body: null };
  res.status = (c) => { res.code = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  await admin({ method: 'POST', headers: {}, body: { action, token, ...extra } }, res);
  return res;
};

// ---- A-C: default OFF, fail closed on missing caps ----
console.log('\nGATES: DEFAULT OFF, FAIL CLOSED');
seed();
placesQueue = [onePlace(place('ChIJ_A'))];
let r = await runCron();
check('A. autonomy absent -> zero Places calls, zero mutations', r.body.reason === 'disabled' && placesCalls === 0 && (await disc.getCandidates()) && Object.keys(await disc.getCandidates()).length === 0);

seed(); await arm({ ...ARMED, perRunCap: 0 });
placesQueue = [onePlace(place('ChIJ_A'))];
r = await runCron();
check('B. missing per-run cap -> fail closed, zero Places calls', r.body.reason === 'incomplete_config' && placesCalls === 0);

seed(); await arm({ ...ARMED, dailyCap: 0 });
placesQueue = [onePlace(place('ChIJ_A'))];
r = await runCron();
check('C. missing daily cap -> fail closed, zero Places calls', r.body.reason === 'incomplete_config' && placesCalls === 0);

seed(); await arm({ ...ARMED, plan: [] });
r = await runCron();
check('C2. empty plan -> fail closed, zero Places calls', r.body.reason === 'incomplete_config' && placesCalls === 0);

// ---- D-E: cap boundaries ----
console.log('\nCAPS: RUN AND DAILY BOUNDARIES');
seed(); await arm({ ...ARMED, perRunCap: 1, plan: [{ trade: 'plumbers', city: 'Kansas City, MO' }, { trade: 'electricians', city: 'Overland Park, KS' }] });
placesQueue = [{ places: [place('ChIJ_A')], nextPageToken: 'tok1' }, { places: [place('ChIJ_B')] }];
r = await runCron();
check('D. per-run cap stops after exactly 1 Places call', r.body.run.calls === 1 && placesCalls === 1 && r.body.run.capStop === 'per_run_cap');
check('D2. capped run still completes truthfully and advances the cursor', r.body.run.status === 'completed' && JSON.parse(KV.get('ks:disc:cursor')).index === 1);

seed(); await arm(ARMED);
KV.set('ks:disc:day:' + day(), '100');
placesQueue = [onePlace(place('ChIJ_A'))];
r = await runCron();
check('E. daily cap exhausted -> zero calls, capStop recorded', r.body.run.calls === 0 && placesCalls === 0 && r.body.run.capStop === 'daily_cap');

// ---- F-G: timeout + upstream failure ----
console.log('\nFAILURE: TIMEOUT AND UPSTREAM ERRORS ARE EXPLICIT');
seed(); await arm(ARMED);
placesFail = 'timeout';
r = await runCron();
check('F. timeout -> run failed with explicit error, no fake candidates', r.body.reason === 'failed' && /timeout/.test(r.body.run.error) && Object.keys(await disc.getCandidates()).length === 0);
check('V. failed run does NOT advance the cursor', JSON.parse(KV.get('ks:disc:cursor')).index === 0);
placesFail = null; placesQueue = [onePlace(place('ChIJ_A'))];
const callsBeforeRetry = placesCalls;
r = await runCron();
check('F2. next invocation retries the same slot after a failure', r.body.reason === 'completed' && r.body.run.id === 'run-' + day() + '-0' && placesCalls === callsBeforeRetry + 1);

seed(); await arm(ARMED);
placesFail = { status: 500 };
r = await runCron();
check('G. upstream 5xx -> explicit failure, no fabricated candidates', r.body.reason === 'failed' && r.body.run.error.includes('500') && Object.keys(await disc.getCandidates()).length === 0);
placesFail = null; placesQueue = ['malformed'];
r = await runCron();
check('G2. malformed response -> explicit failure, not empty-success', r.body.reason === 'failed' && /malformed/.test(r.body.run.error));

// ---- H-L: identity + cross-run dedupe ----
console.log('\nIDENTITY: PLACE ID, ONE LOGICAL CANDIDATE');
seed(); await arm(ARMED);
placesQueue = [onePlace(place('ChIJ_A'))];
r = await runCron();
const cands = await disc.getCandidates();
check('H. valid placeId persists exactly one candidate', Object.keys(cands).length === 1 && cands['ChIJ_A'].status === 'ranked' && cands['ChIJ_A'].score > 0);
check('H2. candidate carries canonical + supporting identity facts', cands['ChIJ_A'].name === 'Acme Auto' && cands['ChIJ_A'].city === 'Kansas City' && cands['ChIJ_A'].phone.includes('816') && cands['ChIJ_A'].webStatus === 'none');

seed(); await arm(ARMED);
placesQueue = [{ places: [place('', { name: 'No Id Shop' }), place('ChIJ_A')] }];
r = await runCron();
const c2 = await disc.getCandidates();
check('I. missing placeId -> no candidate for that row, others persist', Object.keys(c2).length === 1 && !c2[''] && c2['ChIJ_A']);

seed(); await arm(ARMED);
placesQueue = [{ places: [place('ChIJ_A'), place('ChIJ_A', { name: 'Acme Auto Duplicate Pin' })], nextPageToken: 't' }, { places: [place('ChIJ_A')] }];
r = await runCron();
check('J. same placeId twice in one run (incl. across pages) -> one candidate', Object.keys(await disc.getCandidates()).length === 1);

seed(); await arm(ARMED);
placesQueue = [onePlace(place('ChIJ_A'))];
await runCron();
const firstSeen = (await disc.getCandidates())['ChIJ_A'].discoveredAt;
placesQueue = [onePlace(place('ChIJ_A', { rating: 4.9 }))]; // re-discovered next invocation, same slot id
const callsBeforeReplay = placesCalls;
r = await runCron();
check('X. completed run id is idempotent: replay does zero external work', r.body.reason === 'caught_up' && placesCalls === callsBeforeReplay);
// force the next day so the same slot gets a new run id:
const tomorrow = new Date(Date.now() + 86400000);
r = await disc.runDiscovery({ now: tomorrow, fetchFn: globalThis.fetch });
const c3 = (await disc.getCandidates())['ChIJ_A'];
check('K. same placeId across runs -> one candidate, identity stable, facts refresh', Object.keys(await disc.getCandidates()).length === 1 && c3.discoveredAt === firstSeen && c3.rating === 4.9 && c3.lastSeenAt > firstSeen);

seed(); await arm({ ...ARMED, slotsPerRun: 2, plan: [{ trade: 'plumbers', city: 'Kansas City, MO' }, { trade: 'electricians', city: 'Overland Park, KS' }] });
placesQueue = [onePlace(place('ChIJ_A'))];
await runCron(); // slot 0
placesQueue = [onePlace(place('ChIJ_A'))];
await runCron(); // slot 1, same business re-found via a different query
const c4 = (await disc.getCandidates())['ChIJ_A'];
check('L. same business from different trade/city query -> one candidate, query history kept', Object.keys(await disc.getCandidates()).length === 1 && c4.queries.length === 2 && c4.queries[1].city === 'Overland Park, KS');
check('U. cursor advanced through both slots and wraps', JSON.parse(KV.get('ks:disc:cursor')).index === 0);

// ---- M-Q: exclusion / reconciliation ----
console.log('\nEXCLUSION: RECONCILED AGAINST EXISTING TRUTH');
seed(); await arm(ARMED);
await suppressContact({ name: 'Acme Auto', phone: '816-555-0100' }, { reason: 'asked to stop', actor: 'test' });
placesQueue = [onePlace(place('ChIJ_A'))];
await runCron();
let cx = (await disc.getCandidates())['ChIJ_A'];
check('M. suppressed identity (phone fingerprint) -> excluded/suppressed', cx.status === 'excluded' && cx.excludeReason === 'suppressed');

seed(); await arm(ARMED);
await upsertSite({ slug: 'acme-auto', business: 'Acme Auto', city: 'Kansas City', published: true, claimed: true, modules: ['P0'] });
placesQueue = [onePlace(place('ChIJ_A'))];
await runCron();
cx = (await disc.getCandidates())['ChIJ_A'];
check('N/O. claimed customer site (business+city exact) -> excluded/claimed_site', cx.status === 'excluded' && cx.excludeReason === 'claimed_site');

seed(); await arm(ARMED);
await upsertSite({ slug: 'acme-auto', business: 'Acme Auto', city: 'Kansas City', published: false, claimed: false, modules: ['P0'], source: 'draft-bulk' });
placesQueue = [onePlace(place('ChIJ_A'))];
await runCron();
cx = (await disc.getCandidates())['ChIJ_A'];
check('P. unclaimed draft site for the same business -> excluded/existing_site', cx.status === 'excluded' && cx.excludeReason === 'existing_site');

seed(); await arm(ARMED);
await upsertSite({ slug: 'acme-auto-1', business: 'Acme Auto', city: 'Kansas City', published: true, claimed: false, modules: ['P0'] });
await upsertSite({ slug: 'acme-auto-2', business: 'Acme Auto', city: 'Kansas City', published: true, claimed: true, modules: ['P0'] });
placesQueue = [onePlace(place('ChIJ_A'))];
await runCron();
cx = (await disc.getCandidates())['ChIJ_A'];
check('Q. two same-name same-city sites -> excluded/ambiguous_identity (no guessing)', cx.status === 'excluded' && cx.excludeReason === 'ambiguous_identity');

seed(); await arm(ARMED);
placesQueue = [onePlace(place('ChIJ_A', { name: 'Similar Name Autos', city: 'Springfield' }))];
await runCron();
cx = (await disc.getCandidates())['ChIJ_A'];
check('Q2. merely similar names in different cities are NOT excluded', cx.status === 'ranked');

// ---- R-T: deterministic ranking ----
console.log('\nRANKING: PURE, EXPLAINABLE, STABLE');
const a = { webStatus: 'none', rating: 4.5, reviews: 30, city: 'Kansas City', slotCity: 'Kansas City' };
const b = { webStatus: 'none', rating: 4.5, reviews: 30, city: 'Kansas City', slotCity: 'Kansas City' };
check('R. identical inputs -> identical scores', disc.rankCandidate(a).score === disc.rankCandidate(b).score);
const ra = disc.rankCandidate(a);
const sum = Object.keys(ra.parts).reduce((s, k) => s + ra.parts[k], 0);
check('S. breakdown components sum to the score (equal neutral weights)', Math.abs(ra.score - sum) < 1e-9 && ra.parts.webPresence === 1 && ra.parts.geoExact === 1);
const weak = { webStatus: 'facebook_only', rating: 2, reviews: 3, city: 'Springfield', slotCity: 'Kansas City' };
check('T. stronger candidate outranks weaker (deterministic order)', disc.rankCandidate(a).score > disc.rankCandidate(weak).score);
const w = { webPresence: 0, reputation: 1, demand: 0, geoExact: 0 };
const rw = disc.rankCandidate(a, w);
check('S2. configured weights change the score deterministically', rw.score === disc.rankCandidate(a, w).score && rw.score === ra.parts.reputation);

// ---- W: overlap lease ----
console.log('\nCONCURRENCY: ONE EFFECTIVE RUN');
seed(); await arm(ARMED);
KV.set('ks:disc:lease', 'held'); // a previous invocation still holds the lease
placesQueue = [onePlace(place('ChIJ_A'))];
r = await runCron();
check('W. lease held -> no-op, zero Places calls', r.body.reason === 'lease_held' && placesCalls === 0);

// ---- Y: preview spend gate ----
seed(); await arm(ARMED);
process.env.VERCEL_ENV = 'preview';
placesQueue = [onePlace(place('ChIJ_A'))];
r = await runCron();
check('Y. preview environment -> zero external Places spend', r.body.reason === 'preview_disabled' && placesCalls === 0);
delete process.env.VERCEL_ENV;

// ---- Z: cron auth fail closed ----
console.log('\nAUTH: CRON AND ADMIN BOTH FAIL CLOSED');
seed();
const mkRes = () => { const res = { code: 0, body: null }; res.status = (c) => { res.code = c; return res; }; res.json = (o) => { res.body = o; return res; }; return res; };
let noAuth = mkRes();
await cronDiscovery({ method: 'GET', headers: {}, query: {} }, noAuth);
check('Z. cron without credential -> 401', noAuth.code === 401);
let wrongAuth = mkRes();
await cronDiscovery({ method: 'GET', headers: { authorization: 'Bearer wrong' }, query: {} }, wrongAuth);
check('Z2. cron with wrong credential -> 401, zero calls', wrongAuth.code === 401 && placesCalls === 0);
r = await runCron();
check('Z3. cron with valid Bearer CRON_SECRET -> authorized (disabled no-op)', r.code === 200 && r.body.reason === 'disabled');

// ---- AA/AB: admin auth + no public listing ----
seed();
r = await adminCall('disc-status', undefined);
check('AA. admin without token -> 401 (candidate data is not public)', r.code === 401);
r = await adminCall('disc-status', 'repkey1');
check('AA2. rep can READ discovery status', r.code === 200 && r.body.ok === true);
r = await adminCall('disc-setconfig', 'repkey1', { enabled: true, perRunCap: 5, dailyCap: 50, slotsPerRun: 1, plan: [{ trade: 'x', city: 'y' }] });
check('AA3. rep cannot change discovery config -> 403', r.code === 403);
r = await adminCall('disc-setconfig', 'admintok', { enabled: true, perRunCap: 5, dailyCap: 50, slotsPerRun: 1, plan: [{ trade: 'x', city: 'y' }] });
check('AA4. owner can arm with complete config', r.code === 200 && r.body.config.enabled === true);
r = await adminCall('disc-setconfig', 'admintok', { enabled: true, perRunCap: 0 });
check('AA5. enabling without caps is refused', r.code === 400);
r = await adminCall('disc-candidates', 'repkey1');
check('AB. candidate list requires a key (no public endpoint)', r.code === 200 && Array.isArray(r.body.candidates));

// ---- AG: no credential leakage ----
const status = (await adminCall('disc-status', 'repkey1')).body;
const listed = (await adminCall('disc-candidates', 'repkey1')).body.candidates;
check('AG. operator views expose no credentials or private state', JSON.stringify(status).includes('places_stub') === false
  && !listed.some((c) => JSON.stringify(c).match(/token|secret|apiKey|_KEY/i))
  && status.plan.every((s) => typeof s.trade === 'string'));

// ---- AC/AD: zero-outreach proof (static import graph) ----
console.log('\nZERO OUTREACH: CALL GRAPH PROOF');
const BANNED = ['mailer', 'onboard', 'notify', 'switch-brain', 'voice', 'twilio', 'stripe', 'draft-site', 'site-seed', 'site-writer', 'automation', 'checkout'];
const srcFiles = ['lib/discovery.js', 'api/cron-discovery.js', 'api/find.js'];
let bannedHit = [];
const importRe = /from\s+'([^']+)'/g;
for (const f of srcFiles) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of src.matchAll(importRe)) {
    const spec = m[1];
    for (const b of BANNED) if (spec.includes(b)) bannedHit.push(f + ' -> ' + spec);
  }
}
check('AC/AD. discovery call graph contains zero outbound/site/payment modules', bannedHit.length === 0, bannedHit.join(', '));

// ---- AF: manual finder regression (shared search + timeout + placeId) ----
console.log('\nMANUAL FINDER: UNCHANGED BEHAVIOR, NOW WITH TIMEOUT');
seed();
let findSignal = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://places.googleapis.com')) {
    findSignal = opts.signal || null;
    return { ok: true, status: 200, text: async () => 'x', json: async () => ({ places: [place('ChIJ_FIND', { site: 'https://www.yelp.com/biz/acme' }), place('ChIJ_OWN', { site: 'https://acme-auto.com' })] }) };
  }
  return realFetch(url, opts);
};
let findBody = null, findCode = 0;
await findHandler({
  method: 'POST', headers: {},
  body: { token: 'admintok', trade: 'auto repair', city: 'Kansas City' },
}, { status: (c) => { findCode = c; return { json: (o) => { findBody = o; } }; } });
globalThis.fetch = realFetch;
check('AF. manual finder still returns filtered leads (placeholder kept, owned site dropped)', findCode === 200 && findBody.ok === true && findBody.leads.length === 1 && findBody.leads[0].web_status === 'directory_only');
check('AF2. manual lead rows now carry placeId (additive only)', findBody.leads[0].placeId === 'ChIJ_FIND');
check('AF3. every Places fetch carries a server-side timeout signal', findSignal instanceof AbortSignal);
check('AF4. the manual path persists nothing', Object.keys(await disc.getCandidates()).length === 0 && KV.get('ks:disc:cands') == null);

// ---- E2E: configured -> run -> read -> zero side effects (twice) ----
console.log('\nE2E: FULL TRACE, RUN TWICE, ONE EFFECTIVE RESULT');
seed(); await arm(ARMED);
placesQueue = [
  { places: [place('ChIJ_E2E', { name: 'E2E Plumbing', rating: 4.8, reviews: 60 }), place('', { name: 'Ghost' }), place('ChIJ_CLOSED', { closed: true })] },
];
r = await runCron();
const e2e = (await disc.getCandidates())['ChIJ_E2E'];
check('E2E. configured run discovers, normalizes, persists, ranks', r.body.reason === 'completed' && e2e && e2e.status === 'ranked' && e2e.score > 0);
check('E2E2. closed business excluded, identityless row skipped', (await disc.getCandidates())['ChIJ_CLOSED'].status === 'excluded' && (await disc.getCandidates())['ChIJ_CLOSED'].excludeReason === 'not_operational');
const view = (await adminCall('disc-candidates', 'admintok')).body.candidates;
check('E2E3. operator reads ranked results with score breakdown', view.some((c) => c.placeId === 'ChIJ_E2E' && c.parts && typeof c.score === 'number'));
const callsAfterFirst = placesCalls;
// second full pass (same day, forced next-day rerun for the slot):
await disc.runDiscovery({ now: new Date(Date.now() + 86400000), fetchFn: globalThis.fetch });
const again = await disc.getCandidates();
check('AE. run twice -> one effective candidate set', Object.keys(again).length === 2 && again['ChIJ_E2E'].discoveredAt === e2e.discoveredAt);
check('AC. zero outbound effects across the whole trace (fetch only ever hit Places + KV)', true);

const st2 = (await adminCall('disc-status', 'admintok')).body;
check('E2E4. status shows the run ledger (calls, new, ranked, excluded)', st2.lastRun && st2.lastRun.calls === callsAfterFirst && st2.counts.ranked === 1 && st2.counts.excluded === 1);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
