// OWNER-ONLY site-reseed tests (SIMULATED KV — no production data touched).
//
// Covers the auth wall (401/403, zero mutation), fail-closed slug handling
// (nonexistent, malformed, KV-key-shaped input), the two measured legacy
// shapes (solid-ground-engineering completes and passes; old-school-iron
// cannot invent its missing trade/location and reports exact blockers while
// staying published), overwrite protection, unsafe content, idempotency, the
// durable operator repair log, and a no-secrets response sweep.

process.env.KV_REST_API_URL = 'https://kv.reseed.test';
process.env.KV_REST_API_TOKEN = 'token';
process.env.ADMIN_KEY = 'owner-key';
process.env.REP_KEYS = 'dana:r_dana_key';
process.env.KS_FROM_NAME = 'Killswitch Websites';
process.env.LOB_API_KEY = 'test_secret_marker_9x8y7z';
delete process.env.VERCEL_ENV;

import { setupKvStub, clearKvStub } from './helpers/k6-kv.mjs';

const { KV, EXP } = setupKvStub();

const admin = (await import('../api/admin.js')).default;
const { SITE_DEFAULT } = await import('../lib/sites.js');

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

const SOLID_GROUND = { ...SITE_DEFAULT, slug: 'solid-ground-engineering', business: 'Solid Ground Engineering',
  trade: 'Engineering and Drafting', tagline: 'Engineering and Drafting in Eureka, CA', phone: '(619) 549-3274',
  city: 'Eureka', state: 'CA', modules: ['P0'], published: true, claimed: true };
const OLD_SCHOOL = { ...SITE_DEFAULT, slug: 'old-school-iron', business: 'Old School Iron',
  phone: '816-555-0100', modules: ['P0'], published: true, claimed: true };

function seed() {
  KV.clear(); EXP.clear();
  KV.set('ks:site:solid-ground-engineering', JSON.stringify(SOLID_GROUND));
  KV.set('ks:site:old-school-iron', JSON.stringify(OLD_SCHOOL));
  KV.set('ks:leads', JSON.stringify([]));
}
const snapshot = () => JSON.stringify(Array.from(KV.keys()).sort().map((k) => [k, KV.get(k)]));

// ---------------------------------------------------------------------------
console.log('\nAUTH FAILS CLOSED, ZERO MUTATION');
seed();
const before = snapshot();
check('no token -> 401', (await call('site-reseed', null, { slug: 'old-school-iron' })).code === 401);
check('wrong token -> 401', (await call('site-reseed', 'nope', { slug: 'old-school-iron' })).code === 401);
check('rep token -> 403', (await call('site-reseed', 'r_dana_key', { slug: 'old-school-iron' })).code === 403);
check('zero mutation from all refused calls', snapshot() === before);

console.log('\nSLUG HANDLING FAILS CLOSED');
check('nonexistent site -> 404', (await call('site-reseed', 'owner-key', { slug: 'no-such-shop' })).code === 404);
check('missing slug -> 400', (await call('site-reseed', 'owner-key', {})).code === 400);
check('slug with no usable characters -> 400', (await call('site-reseed', 'owner-key', { slug: '***' })).code === 400);
check('path-traversal input slugifies to an inert miss -> 404, zero mutation', (await call('site-reseed', 'owner-key', { slug: '../../etc/passwd' })).code === 404);
check('a raw KV key is not addressable', (await call('site-reseed', 'owner-key', { slug: 'ks:site:old-school-iron' })).code === 404);
check('zero mutation from all bad-input calls', snapshot() === before);

// ---------------------------------------------------------------------------
console.log('\nCASE A: solid-ground-engineering (trade + location present)');
seed();
let r = await call('site-reseed', 'owner-key', { slug: 'solid-ground-engineering' });
check('it completes the record', r.code === 200 && r.body.changed === true && r.body.fieldsAdded.includes('about'), JSON.stringify(r.body.fieldsAdded));
check('it invents NO services', r.body.servicesPresent === false && JSON.parse(KV.get('ks:site:solid-ground-engineering')).services.length === 0);
check('quality passes', r.body.qualityPass === true && r.body.blockers.length === 0, JSON.stringify(r.body.blockers));
check('schema and useful meta confirmed live-shaped', r.body.schemaPresent === true && r.body.usefulMetaPresent === true);
check('it stays published and claimed', r.body.publicationState === 'claimed'
  && JSON.parse(KV.get('ks:site:solid-ground-engineering')).published === true && JSON.parse(KV.get('ks:site:solid-ground-engineering')).claimed === true);
check('existing facts were not rewritten', JSON.parse(KV.get('ks:site:solid-ground-engineering')).tagline === 'Engineering and Drafting in Eureka, CA'
  && JSON.parse(KV.get('ks:site:solid-ground-engineering')).phone === '(619) 549-3274');

console.log('\nCASE B: old-school-iron (no trade, no location — must NOT be invented)');
r = await call('site-reseed', 'owner-key', { slug: 'old-school-iron' });
const osi = JSON.parse(KV.get('ks:site:old-school-iron'));
check('only derivable fields were filled', r.body.changed === true
  && r.body.fieldsAdded.sort().join(',') === 'about,layout,theme', JSON.stringify(r.body.fieldsAdded));
check('trade and city were NOT invented', osi.trade === '' && osi.city === '' && osi.state === '');
check('the about is the generic factual sentence, nothing more', osi.about === 'Old School Iron is a local business.', osi.about);
check('quality still fails with the exact missing facts', r.body.qualityPass === false
  && r.body.blockers.includes('no_usable_trade') && r.body.blockers.includes('no_usable_location'), JSON.stringify(r.body.blockers));
check('the published legacy site stays published', r.body.publicationState === 'claimed' && osi.published === true && osi.claimed === true);
check('no services section was invented', r.body.servicesPresent === false && osi.services.length === 0);

// ---------------------------------------------------------------------------
console.log('\nIDEMPOTENT: THE SECOND RUN CHANGES NOTHING');
r = await call('site-reseed', 'owner-key', { slug: 'old-school-iron' });
check('second run reports changed=false', r.body.changed === false && r.body.fieldsAdded.length === 0);
check('the record is byte-identical', KV.get('ks:site:old-school-iron') === JSON.stringify(osi));
r = await call('site-reseed', 'owner-key', { slug: 'solid-ground-engineering' });
check('second run on the completed record is also a no-op', r.body.changed === false);

console.log('\nOPERATOR REPAIR LOG');
const logHash = KV.get('ks:admin:reseed-log') || {};
const entries = Object.values(logHash).map((v) => JSON.parse(v));
check('every invocation is recorded', entries.length === 4, String(entries.length));
check('entries name the action, slug, actor and result', entries.every((e) => e.action === 'site-reseed' && e.slug && e.actor === 'operator'
  && typeof e.changed === 'boolean' && typeof e.qualityPass === 'boolean'));
check('the sparse record\'s blockers are in the log', entries.some((e) => e.slug === 'old-school-iron' && e.blockers.includes('no_usable_trade')));

// ---------------------------------------------------------------------------
console.log('\nOWNER WORDS AND UNSAFE CONTENT');
seed();
KV.set('ks:site:solid-ground-engineering', JSON.stringify({ ...SOLID_GROUND, about: 'We answer the phone ourselves.', theme: 'midnight' }));
r = await call('site-reseed', 'owner-key', { slug: 'solid-ground-engineering' });
const sg = JSON.parse(KV.get('ks:site:solid-ground-engineering'));
check('owner about and chosen theme are never overwritten', sg.about === 'We answer the phone ourselves.' && sg.theme === 'midnight');

seed();
KV.set('ks:site:old-school-iron', JSON.stringify({ ...OLD_SCHOOL, about: 'Nice shop <script>alert(1)</script>' }));
r = await call('site-reseed', 'owner-key', { slug: 'old-school-iron' });
check('unsafe stored content is not rewritten, it is REPORTED', r.body.qualityPass === false && r.body.blockers.includes('unsafe_content'));
check('and it never reaches a render unescaped', !JSON.stringify(r.body).includes('<script>alert(1)</script>'));

console.log('\nNO SECRETS IN THE RESPONSE');
r = await call('site-reseed', 'owner-key', { slug: 'solid-ground-engineering' });
const payload = JSON.stringify(r.body);
check('no Lob key material', !payload.includes('test_secret_marker_9x8y7z'));
check('no KV internals', !payload.includes('ks:site:') && !payload.includes('KV_REST'));
check('response is the operator summary shape',
  ['slug', 'changed', 'fieldsAdded', 'qualityPass', 'blockers', 'publicationState', 'schemaPresent', 'usefulMetaPresent', 'servicesPresent']
    .every((k) => k in r.body), Object.keys(r.body).join(','));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
clearKvStub();
process.exit(fail ? 1 : 0);
