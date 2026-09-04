// ONE FRANCHISEE MUST NEVER SEE ANOTHER'S DATA.
//
// This is the test that matters most in the whole suite. Everything else here
// fails by annoying somebody; this fails by showing one paying business another
// paying business's customers, revenue and private portal links.
//
// It runs the REAL lib/kv.js and lib/tenant.js against a fake Redis that records
// the literal key strings sent on the wire, because the only proof that two
// tenants are separated is that the keys they touch are different.
process.env.KV_REST_API_URL = 'https://kv.test/';
process.env.KV_REST_API_TOKEN = 'kvtok';
process.env.KS_HOME_DOMAINS = 'killswitchwebsites.com,localhost';

const KV = new Map();
const seenKeys = [];      // every key that actually reached the wire
let failNext = false;
globalThis.fetch = async (url, opts = {}) => {
  if (failNext) { failNext = false; throw new Error('kv is down'); }
  const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  const args = JSON.parse(opts.body);
  const run = (a) => {
    const c = String(a[0]).toUpperCase(), k = a[1];
    seenKeys.push(k);
    if (c === 'GET') return KV.has(k) ? KV.get(k) : null;
    if (c === 'SET') { KV.set(k, a[2]); return 'OK'; }
    if (c === 'DEL') { const had = KV.has(k); KV.delete(k); return had ? 1 : 0; }
    if (c === 'HSET') { const h = KV.get(k) || {}; h[a[2]] = a[3]; KV.set(k, h); return 1; }
    if (c === 'HGET') { const h = KV.get(k) || {}; return h[a[2]] == null ? null : h[a[2]]; }
    if (c === 'HDEL') { const h = KV.get(k) || {}; const had = a[2] in h; delete h[a[2]]; KV.set(k, h); return had ? 1 : 0; }
    if (c === 'HGETALL') { const h = KV.get(k) || {}; const o = []; for (const [f, v] of Object.entries(h)) o.push(f, v); return o; }
    throw new Error('unsupported in test: ' + c);
  };
  if (String(url).endsWith('/pipeline')) return json(args.map((a) => ({ result: run(a) })));
  return json({ result: run(args) });
};

const { cmd, pipeline, keyFor, runAsTenant, currentTenant, ROOT, rootCmd } = await import('../lib/kv.js');
const T = await import('../lib/tenant.js');
const S = await import('../lib/sites.js');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

console.log('\nTODAY\'S DATA MUST NOT MOVE');

// If the home tenant started using prefixed keys, one deploy would make every
// live customer, site and billing link invisible. Root is deliberately unprefixed.
check('root writes the exact key it writes today', keyFor('ks:site:joes', ROOT) === 'ks:site:joes', keyFor('ks:site:joes', ROOT));
check('and with no tenant set at all, which is every existing code path',
  keyFor('ks:accounts') === 'ks:accounts', keyFor('ks:accounts'));
check('the current tenant defaults to root', currentTenant() === ROOT, JSON.stringify(currentTenant()));

process.env.VERCEL_ENV = 'preview';
check('a Vercel preview is isolated from production data',
  keyFor('ks:accounts') === 'ks:env:preview:accounts', keyFor('ks:accounts'));
check('preview isolation also wraps tenant data',
  keyFor('ks:site:joes', 'bob') === 'ks:env:preview:t:bob:site:joes', keyFor('ks:site:joes', 'bob'));
delete process.env.VERCEL_ENV;

console.log('\nA TENANT GETS ITS OWN KEYSPACE');

check('a tenant key is prefixed', keyFor('ks:site:joes', 'bob') === 'ks:t:bob:site:joes', keyFor('ks:site:joes', 'bob'));
check('and so is every other kind of key',
  keyFor('ks:accounts', 'bob') === 'ks:t:bob:accounts' && keyFor('ks:crm:x', 'bob') === 'ks:t:bob:crm:x');
check('an already-scoped key is never double-prefixed, which the pipeline fallback relies on',
  keyFor('ks:t:bob:site:joes', 'bob') === 'ks:t:bob:site:joes', keyFor('ks:t:bob:site:joes', 'bob'));
check('a non-ks string is passed straight through, so a VALUE can never be mangled',
  keyFor('hello world', 'bob') === 'hello world' && keyFor('', 'bob') === '');
check('and so is a non-string', keyFor(42, 'bob') === 42);

console.log('\nTHE ONE THAT MATTERS: TWO TENANTS, SAME SLUG');

// Both franchisees have a customer called "Joe's Plumbing". Same slug, same
// business name, different people. This is not a contrived case; it is what
// happens the week you have two franchisees.
await runAsTenant('bob', () => S.upsertSite({ business: "Joe's Plumbing", email: 'joe@bob.test', phone: 'BOB-PHONE', published: true }));
await runAsTenant('alice', () => S.upsertSite({ business: "Joe's Plumbing", email: 'joe@alice.test', phone: 'ALICE-PHONE', published: true }));

const bobsJoe = await runAsTenant('bob', () => S.getSite('joes-plumbing'));
const alicesJoe = await runAsTenant('alice', () => S.getSite('joes-plumbing'));
check("bob sees bob's Joe", bobsJoe && bobsJoe.phone === 'BOB-PHONE', bobsJoe && bobsJoe.phone);
check("alice sees alice's Joe", alicesJoe && alicesJoe.phone === 'ALICE-PHONE', alicesJoe && alicesJoe.phone);
check('and they are genuinely different records', bobsJoe.email !== alicesJoe.email);

const bobList = await runAsTenant('bob', () => S.listSites());
const aliceList = await runAsTenant('alice', () => S.listSites());
check('bob lists exactly one site, not two', bobList.length === 1, JSON.stringify(bobList.map((s) => s.email)));
check('alice lists exactly one site, not two', aliceList.length === 1, JSON.stringify(aliceList.map((s) => s.email)));

// The email join is the lookup that binds a customer's panel to their site.
const byEmail = await runAsTenant('bob', () => S.siteForEmail('joe@alice.test'));
check("bob CANNOT reach alice's customer by email", byEmail === null, JSON.stringify(byEmail && byEmail.email));

const rootSees = await S.getSite('joes-plumbing');
check('and the home tenant sees neither of them', rootSees === null, JSON.stringify(rootSees && rootSees.email));

console.log('\nTHE RACE THAT WOULD LEAK DATA SILENTLY');

// A module-level `let currentTenant` would pass every test above and still be a
// breach: two requests interleaving at an await would swap tenants mid-flight.
// This runs them genuinely concurrently, with awaits in between, and asserts
// each one still sees its own data when it resumes.
const interleaved = await Promise.all([
  runAsTenant('bob', async () => {
    const a = currentTenant();
    await new Promise((r) => setTimeout(r, 12));
    const site = await S.getSite('joes-plumbing');
    await new Promise((r) => setTimeout(r, 6));
    return { start: a, end: currentTenant(), phone: site && site.phone };
  }),
  runAsTenant('alice', async () => {
    await new Promise((r) => setTimeout(r, 4));
    const site = await S.getSite('joes-plumbing');
    await new Promise((r) => setTimeout(r, 10));
    return { start: 'alice', end: currentTenant(), phone: site && site.phone };
  }),
  runAsTenant('bob', async () => {
    await new Promise((r) => setTimeout(r, 8));
    return { start: 'bob', end: currentTenant(), phone: (await S.getSite('joes-plumbing')).phone };
  }),
]);
check('bob stays bob across every await', interleaved[0].end === 'bob' && interleaved[0].phone === 'BOB-PHONE', JSON.stringify(interleaved[0]));
check('alice stays alice while bob is mid-request', interleaved[1].end === 'alice' && interleaved[1].phone === 'ALICE-PHONE', JSON.stringify(interleaved[1]));
check('and a second bob request is unaffected by both', interleaved[2].phone === 'BOB-PHONE', JSON.stringify(interleaved[2]));

// Same again through a pipeline, which takes a different code path.
seenKeys.length = 0;
await runAsTenant('carol', () => pipeline([['SET', 'ks:one', '1'], ['HSET', 'ks:two', 'f', 'v']]));
check('a pipeline scopes EVERY command in the batch, not just the first',
  seenKeys.every((k) => k.startsWith('ks:t:carol:')), JSON.stringify(seenKeys));

console.log('\nAN UNKNOWN DOMAIN IS A REFUSAL, NEVER A FALLBACK');

check('the home domain is root', (await T.tenantForHost('killswitchwebsites.com')).root === true);
check('with a port attached, as a browser sends it', (await T.tenantForHost('localhost:3000')).root === true);
check('and no host at all is root, which is how crons and scripts run',
  (await T.tenantForHost('')).id === ROOT);

let threw = null;
try { await T.tenantForHost('some-random-domain.com'); } catch (e) { threw = e; }
check('an unregistered domain THROWS rather than quietly serving root data',
  threw && threw.code === 'unknown_tenant_domain', String(threw && threw.message));

// Every deploy is served at a fresh <project>-<hash>-<team>.vercel.app, so those
// can never be in a list. Without this, turning tenants on would 404 every
// preview build and any production hit that arrived on the deployment URL.
check('our own deployment URLs are root, so previews keep working',
  (await T.tenantForHost('killswitch-2o6v6vnld-limen-helix.vercel.app')).root === true);
check('and so is the bare project URL', (await T.tenantForHost('killswitch.vercel.app')).root === true);

const added = await T.addTenant({ id: 'bob', domain: 'BobsSites.com', name: "Bob's Sites" });
check('a franchisee can be registered', added.ok && added.domain === 'bobssites.com', JSON.stringify(added));
check('and their domain now resolves to them', (await T.tenantForHost('bobssites.com')).id === 'bob');
check('case and port on the way in do not matter', (await T.tenantForHost('BOBSSITES.COM:443')).id === 'bob');

// www is deliberately NOT assumed: guessing is how you serve the wrong business.
let wwwThrew = null;
try { await T.tenantForHost('www.bobssites.com'); } catch (e) { wwwThrew = e; }
check('www is not silently assumed, it has to be registered too', !!wwwThrew, 'www resolved without being registered');

console.log('\nA TENANT ID CANNOT REACH INTO ANOTHER KEYSPACE');

// The id becomes part of a Redis key, so a colon in it would let one tenant
// address another's data by name.
for (const bad of ['bob:alice', 'a', '', 'Bob', 'bob alice', 'ks:t:alice', '../alice', 'bob/alice']) {
  check('rejected as a tenant id: ' + JSON.stringify(bad), T.validTenantId(bad) === false);
}
check('a normal id is accepted', T.validTenantId('bobs-sites') === true);
const evil = await T.addTenant({ id: 'bob:alice', domain: 'evil.test' });
check('and addTenant refuses it', !evil.ok && evil.error === 'bad_tenant_id', JSON.stringify(evil));

const steal = await T.addTenant({ id: 'alice', domain: 'bobssites.com' });
check('one franchisee cannot take over another\'s live domain',
  !steal.ok && steal.error === 'domain_taken_by_bob', JSON.stringify(steal));
check('and the domain still belongs to bob', (await T.tenantForHost('bobssites.com')).id === 'bob');

console.log('\nTHE REGISTRY ITSELF IS ALWAYS ROOT-LEVEL');

// Read through the normal path it would be scoped to the tenant we are still
// trying to identify, which is circular and would never resolve anyone.
seenKeys.length = 0;
await runAsTenant('bob', () => T.registry(true));
check('the tenant map is read unprefixed even from inside a tenant',
  seenKeys.includes('ks:tenants'), JSON.stringify(seenKeys));

seenKeys.length = 0;
await runAsTenant('bob', () => rootCmd(['GET', 'ks:system-thing']));
check('rootCmd escapes the tenant for genuinely system-wide data',
  seenKeys[0] === 'ks:system-thing', JSON.stringify(seenKeys));
check('and the tenant is restored afterwards', await runAsTenant('bob', async () => {
  await rootCmd(['GET', 'ks:x']);
  return currentTenant() === 'bob';
}));

console.log('\nFAILING TO READ THE REGISTRY MUST NOT OPEN THE DOOR');

T.invalidate();
failNext = true;
let downErr = null;
try { await T.tenantForHost('bobssites.com'); } catch (e) { downErr = e; }
check('a registry we cannot read refuses, rather than treating it as empty and falling back',
  !!downErr, 'it resolved anyway with the store down');

console.log('\nTHE DESIGN ASSUMPTION, CHECKED RATHER THAN ASSUMED');

// The rewrite only touches args[1]. That is correct for every command in use
// and wrong the moment somebody adds MGET or RENAME, which would then leak.
import fsp from 'node:fs/promises';
const libs = await fsp.readdir(new URL('../lib/', import.meta.url));
let src = '';
for (const f of libs) if (f.endsWith('.js')) src += await fsp.readFile(new URL('../lib/' + f, import.meta.url), 'utf8');
const apis = await fsp.readdir(new URL('../api/', import.meta.url));
for (const f of apis) if (f.endsWith('.js')) src += await fsp.readFile(new URL('../api/' + f, import.meta.url), 'utf8');
const multiKey = ['MGET', 'MSET', 'RENAME', 'COPY', 'SMOVE', 'SUNIONSTORE', 'SINTERSTORE', 'ZUNIONSTORE', 'BITOP', 'PFMERGE', 'GETDEL', 'RENAMENX'];
const found = multiKey.filter((c) => new RegExp("'" + c + "'").test(src));
check('no multi-key Redis command has been introduced (they would defeat the key rewrite)',
  found.length === 0, 'found: ' + found.join(', '));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
