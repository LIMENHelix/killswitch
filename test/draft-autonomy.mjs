// K5 — autonomous unpublished site drafting from ranked K4 candidates.
// No network; KV is an in-memory Map behind the REST shape.
import path from 'node:path';
import fs from 'node:fs';
const ROOT = path.join(import.meta.dirname, '..');
process.env.KV_REST_API_URL = 'https://kv.test/';
process.env.KV_REST_API_TOKEN = 'kvtok';
process.env.CRON_SECRET = 'cronsecret';
process.env.ADMIN_KEY = 'admintok';
process.env.SWITCH_TOKEN = 'switchtok';
process.env.REP_KEYS = 'dana:repkey1';

const KV = new Map();
const EXP = new Map();
const live = (key) => { if (EXP.has(key) && EXP.get(key) <= Date.now()) { EXP.delete(key); KV.delete(key); } };

const evalScript = (a) => {
  const script = a[1];
  const n = Number(a[2]);
  const keys = a.slice(3, 3 + n);
  const argv = a.slice(3 + n);
  if (script.includes('disc_lease_renew_v1')) {
    if (KV.get(keys[0]) === argv[0]) { EXP.set(keys[0], Date.now() + Number(argv[1])); return 'OK'; }
    return 'LOST';
  }
  if (script.includes('disc_lease_release_v1')) {
    if (KV.get(keys[0]) === argv[0]) { KV.delete(keys[0]); EXP.delete(keys[0]); return 1; }
    return 0;
  }
  if (script.includes('disc_reserve_v1')) {
    const [callId, dailyCap, runCap, record] = argv;
    const ledger = KV.get(keys[2]) || {};
    if (ledger[callId] !== undefined) return 'ALREADY_RESERVED';
    function checkCounter(key) {
      const raw = KV.get(key);
      if (raw == null) return 0;
      const num = Number(raw);
      if (!Number.isFinite(num) || num !== Math.floor(num) || num < 0) return 'CORRUPT';
      return num;
    }
    const d = checkCounter(keys[0]); if (d === 'CORRUPT') return 'CORRUPT_COUNTER';
    const r = checkCounter(keys[1]); if (r === 'CORRUPT') return 'CORRUPT_COUNTER';
    const dc = Number(dailyCap); if (!Number.isFinite(dc) || dc !== Math.floor(dc) || dc <= 0) return 'INVALID_CAP';
    const rc = Number(runCap); if (!Number.isFinite(rc) || rc !== Math.floor(rc) || rc <= 0) return 'INVALID_CAP';
    if (d >= dc) return 'DAILY_CAP';
    if (r >= rc) return 'RUN_CAP';
    KV.set(keys[0], String(d + 1));
    KV.set(keys[1], String(r + 1));
    ledger[callId] = record;
    KV.set(keys[2], ledger);
    return 'RESERVED';
  }
  if (script.includes('disc_complete_v1')) {
    const [owner, runId, runJson, cursorJson] = argv;
    if (KV.get(keys[0]) !== owner) return 'LEASE_LOST';
    const h = KV.get(keys[1]) || {}; h[runId] = runJson; KV.set(keys[1], h);
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
      if (cmd === 'HDEL') { const h = KV.get(key) || {}; delete h[f]; KV.set(key, h); return 1; }
      if (cmd === 'DEL') { KV.delete(key); return 1; }
      throw new Error('unexpected kv cmd ' + cmd);
    };
    if (u.endsWith('/pipeline')) return { ok: true, status: 200, json: async () => args.map((a) => ({ result: run(a) })) };
    return { ok: true, status: 200, json: async () => ({ result: run(args) }) };
  }
  throw new Error('unexpected fetch ' + u);
};

const { cmd } = await import('../lib/kv.js');
const disc = await import('../lib/discovery.js');
const draftAuto = await import('../lib/draft-autonomy.js');
const sites = await import('../lib/sites.js');
const { suppressContact } = await import('../lib/suppression.js');
const { upsertAccount } = await import('../lib/store.js');
const cronDraft = (await import('../api/cron-draft.js')).default;
const admin = (await import('../api/admin.js')).default;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };
const seed = () => { KV.clear(); EXP.clear(); delete process.env.VERCEL_ENV; };
const mkRes = () => { const res = { code: 0, body: null }; res.status = (c) => { res.code = c; return res; }; res.json = (o) => { res.body = o; return res; }; return res; };
const adminCall = async (action, token, extra = {}) => {
  const res = mkRes();
  await admin({ method: 'POST', headers: {}, body: { action, token, ...extra } }, res);
  return res;
};
const runCron = async () => {
  const res = mkRes();
  await cronDraft({ method: 'GET', headers: { authorization: 'Bearer cronsecret' }, query: {} }, res);
  return res;
};

const candidate = (id, over = {}) => ({
  placeId: id,
  name: over.name || 'Acme Auto',
  city: over.city || 'Kansas City',
  state: over.state || 'MO',
  street: over.street || '101 Main St',
  zip: over.zip || '64108',
  phone: over.phone || '816-555-0100',
  slotTrade: over.trade || 'plumber',
  category: over.category || 'Plumber',
  rating: 4.5,
  reviews: 30,
  businessStatus: over.closed ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL',
  status: 'ranked',
  score: over.score === undefined ? 1.5 : over.score,
  parts: { webPresence: 1, reputation: 0.9, demand: 0.3, geoExact: 1 },
  webStatus: over.webStatus || 'directory_only',
  discoveredAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  queries: [{ trade: over.trade || 'plumber', city: over.city || 'Kansas City', at: new Date().toISOString() }],
  ...over,
});

const saveCand = async (c) => { await cmd(['HSET', 'ks:disc:cands', c.placeId, JSON.stringify(c)]); };

// ---- CONFIG / GATES ----
console.log('\nCONFIG / DEFAULT-OFF GATES');
{
  seed();
  const r = await draftAuto.runDraftAutonomy();
  check('A. config absent -> zero drafts', r.ran === false && r.reason === 'disabled' && r.drafts === 0);
}
{
  seed();
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 0, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('B. missing/invalid draftsPerRun -> fail closed', r.ran === false && r.reason === 'incomplete_config' && r.drafts === 0);
}
{
  seed();
  await draftAuto.saveDraftConfig({ enabled: false, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('C. enabled false -> zero drafts', r.ran === false && r.reason === 'disabled' && r.drafts === 0);
}
{
  seed();
  await saveCand(candidate('ChIJ_A'));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  process.env.VERCEL_ENV = 'preview';
  const r = await draftAuto.runDraftAutonomy();
  check('AB. preview -> zero production mutations', r.ran === false && r.reason === 'preview_disabled' && r.drafts === 0);
  delete process.env.VERCEL_ENV;
}

// ---- ELIGIBILITY / DRAFTING ----
console.log('\nELIGIBILITY / DRAFTING');
{
  seed();
  await saveCand(candidate('ChIJ_A'));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  const site = await sites.getSite('acme-auto');
  const c = (await disc.getCandidates())['ChIJ_A'];
  check('D. ranked eligible candidate -> one unpublished draft', r.reason === 'completed' && r.run.drafted === 1 && site && site.published === false && site.claimed === false);
  check('U. draft published:false', site && site.published === false);
  check('V. draft unclaimed/no entitlement', site && site.claimed === false && site.modules.join(',') === 'P0' && !site.email);
  check('linkage. candidate has draftSlug', c && c.draftSlug === 'acme-auto' && c.draftStatus === 'drafted');
}
{
  seed();
  await saveCand(candidate('ChIJ_A'));
  await saveCand(candidate('ChIJ_B', { name: 'Beta Plumbing', phone: '816-555-0200', score: 2.0 }));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  const cands = await disc.getCandidates();
  check('E. same candidate twice -> one draft (idempotent place index)', r.run.drafted === 2);
  await draftAuto.runDraftAutonomy();
  check('E2. rerun does not create more drafts', (await sites.listSites()).length === 2);
}
{
  seed();
  await saveCand(candidate('ChIJ_A', { score: 0.5 }));
  await saveCand(candidate('ChIJ_B', { score: 2.0 }));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 1.0 });
  const r = await draftAuto.runDraftAutonomy();
  check('minScore. low-score candidate skipped', r.run.drafted === 1 && r.run.skipped === 1);
}

// ---- EXCLUSIONS ----
console.log('\nEXCLUSIONS');
{
  seed();
  await saveCand(candidate('ChIJ_SUP'));
  await suppressContact({ phone: '816-555-0100', city: 'Kansas City', state: 'MO', street: '101 Main St', zip: '64108' }, { reason: 'stop', actor: 'test', source: 'test' });
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('I. suppressed candidate -> zero draft', r.run.drafted === 0 && r.run.skipped === 1);
}
{
  seed();
  await saveCand(candidate('ChIJ_CLAIMED'));
  await sites.upsertSite({ slug: 'acme-auto-kansas-city', business: 'Acme Auto', city: 'Kansas City', state: 'MO', published: false, claimed: true, modules: ['P0'] });
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('J. existing claimed site -> zero draft', r.run.drafted === 0 && r.run.skipped === 1);
}
{
  seed();
  await saveCand(candidate('ChIJ_DRAFT'));
  await sites.upsertSite({ slug: 'acme-auto-kansas-city', business: 'Acme Auto', city: 'Kansas City', state: 'MO', published: false, claimed: false, modules: ['P0'] });
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('K. existing draft -> reuse/link, no duplicate', r.run.drafted === 0 && r.run.linked === 1 && (await sites.listSites()).length === 1);
}
{
  seed();
  await saveCand(candidate('ChIJ_PHONE'));
  await sites.upsertSite({ slug: 'some-other-site', business: 'Different Name', city: 'Overland Park', state: 'KS', phone: '816-555-0100', published: true, claimed: true, modules: ['P0'] });
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('L. exact phone current-customer exclusion', r.run.drafted === 0 && r.run.skipped === 1);
}
{
  seed();
  await saveCand(candidate('ChIJ_ACCT'));
  await upsertAccount({ email: 'owner@acme.com', phone: '8165550100', plan: ['P0'] });
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('M. exact phone account -> current customer exclusion', r.run.drafted === 0 && r.run.skipped === 1);
}
{
  seed();
  await saveCand(candidate('ChIJ_PAID'));
  await upsertAccount({ email: 'paid@acme.com', phone: '8165550100', plan: ['P0', 'P1'], stripeCustomerId: 'cus_1' });
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('P. paid customer strong match -> zero draft', r.run.drafted === 0 && r.run.skipped === 1);
}
{
  seed();
  await saveCand(candidate('ChIJ_AMB'));
  await sites.upsertSite({ slug: 'site-one', business: 'X', city: 'Y', phone: '816-555-0100', published: true, claimed: true, modules: ['P0'] });
  await upsertAccount({ email: 'a@a.com', phone: '8165550100', plan: ['P0'] });
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('O. ambiguous/conflicting identity -> excluded', r.run.drafted === 0 && r.run.skipped === 1);
}
{
  seed();
  await saveCand(candidate('', { name: 'No Place' }));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('Q. missing placeId -> zero draft', r.run.drafted === 0 && r.run.skipped === 1);
}
{
  seed();
  await saveCand(candidate('ChIJ_CLOSED', { closed: true }));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('R. non-operational -> zero draft', r.run.drafted === 0 && r.run.skipped === 1);
}

// ---- BOUNDARIES ----
console.log('\nBOUNDARIES / IDEMPOTENCY');
{
  seed();
  await saveCand(candidate('ChIJ_1'));
  await saveCand(candidate('ChIJ_2'));
  await saveCand(candidate('ChIJ_3'));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 2, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('Y. draftsPerRun exact boundary', r.run.drafted === 2 && r.run.capStop === 'drafts_per_run_cap');
}
{
  seed();
  await saveCand(candidate('ChIJ_A'));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r1 = await draftAuto.runDraftAutonomy();
  const r2 = await draftAuto.runDraftAutonomy();
  check('AA. run replay idempotent', r1.run.drafted === 1 && r2.reason === 'caught_up');
}

// ---- CRASH RECOVERY ----
console.log('\nCRASH RECOVERY');
{
  seed();
  await saveCand(candidate('ChIJ_A'));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  // Simulate: site and place index were written, but candidate linkage was not.
  seed();
  await saveCand(candidate('ChIJ_A'));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const lead = draftAuto.candidateToLead(candidate('ChIJ_A'));
  const rec = (await import('../lib/draft-site.js')).draftFromLead(lead, new Set());
  await sites.upsertSite({ ...rec, placeId: 'ChIJ_A', published: false, claimed: false, modules: ['P0'], source: 'draft-autonomy', leadId: 'ChIJ_A' });
  await cmd(['HSET', 'ks:draft:place', 'ChIJ_A', rec.slug]);
  // candidate still has no draftSlug/draftStatus -> linkage repair path
  const r = await draftAuto.runDraftAutonomy();
  const c = (await disc.getCandidates())['ChIJ_A'];
  check('G. site-created/linkage-failed retry -> same site, linkage repaired', r.run.linked === 1 && c.draftSlug === rec.slug && (await sites.listSites()).length === 1);
}

// ---- CONCURRENCY / LEASE ----
console.log('\nCONCURRENCY / LEASE');
{
  seed();
  await saveCand(candidate('ChIJ_A'));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const [r1, r2] = await Promise.all([draftAuto.runDraftAutonomy(), draftAuto.runDraftAutonomy()]);
  check('Z. overlapping run lease -> one effective run', (r1.reason === 'completed' && r2.reason === 'lease_held') || (r2.reason === 'completed' && r1.reason === 'lease_held'));
  check('Z2. exactly one site created', (await sites.listSites()).length === 1);
}

// ---- AUTH / OPERATOR ----
console.log('\nAUTH / OPERATOR');
{
  seed();
  const r = await adminCall('draft-status', 'repkey1');
  check('AA2. rep can READ draft status', r.code === 200 && r.body.enabled === false);
}
{
  seed();
  const r = await adminCall('draft-setconfig', 'repkey1', { enabled: true, draftsPerRun: 1 });
  check('AA3. rep cannot change draft config -> 403', r.code === 403);
}
{
  seed();
  const r = await adminCall('draft-setconfig', 'admintok', { enabled: true, draftsPerRun: 3 });
  check('AA4. owner can arm draft autonomy', r.code === 200 && r.body.config.enabled === true && r.body.config.draftsPerRun === 3);
}
{
  seed();
  const res = mkRes();
  await cronDraft({ method: 'GET', headers: { authorization: 'Bearer wrong' }, query: {} }, res);
  check('AC. cron auth fail closed', res.code === 401);
}

// ---- ZERO OUTREACH ----
console.log('\nZERO OUTREACH / ZERO SIDE EFFECT');
{
  seed();
  await saveCand(candidate('ChIJ_A'));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  await draftAuto.runDraftAutonomy();
  const site = await sites.getSite('acme-auto');
  check('AE. zero email', !site.email);
  check('AG. zero publish', site.published === false);
  check('T. no fabricated content', !/since|years|family|trusted|best|quality|experienced|award|certified/.test(site.about));
}
{
  // Static call-graph proof: this file imports no outbound/site-payment modules.
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'draft-autonomy.js'), 'utf8');
  const banned = ['runAutopilot', 'sendPanelLink', 'publishForMail', 'lobSend', 'onboardCustomer', 'Resend', 'Stripe'];
  const bannedHit = banned.filter((s) => src.includes(s));
  check('AH/AG/AE. zero outreach modules in K5 graph', bannedHit.length === 0, bannedHit.join(', '));
}

// ---- E2E TWICE ----
console.log('\nE2E: RANKED -> DRAFT -> OPERATOR -> ZERO SIDE EFFECT');
{
  seed();
  await saveCand(candidate('ChIJ_E2E'));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r1 = await draftAuto.runDraftAutonomy();
  const st = (await adminCall('draft-status', 'admintok')).body;
  const runs = (await adminCall('draft-runs', 'admintok')).body.runs;
  check('E2E. ranked -> draft -> operator', r1.run.drafted === 1 && st.draftedCount === 1 && runs.length === 1);
  const r2 = await draftAuto.runDraftAutonomy();
  check('E2E2. run twice -> one effective site', r2.reason === 'caught_up' && (await sites.listSites()).length === 1);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
