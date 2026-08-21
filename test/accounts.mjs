// TWO CUSTOMERS MUST NOT BE ABLE TO ERASE EACH OTHER'S BILLING.
//
// Accounts were one JSON blob. Every read of one read all of them and every
// write rewrote all of them, so two customers flipping a switch in the same
// second did this:
//
//   A reads all        B reads all
//   A writes back      B writes back, still holding A's old data  -> A's change gone
//
// What gets erased is `ending`, the map that decides when a switched-off module
// actually stops being paid for. So the failure is a customer still being
// charged for something they cancelled, with both operations reporting success.
//
// These run the REAL lib/store.js against a fake Redis and prove three things:
// the race is closed, today's live data survives the change, and the daily
// backup captures the accounts that exist rather than a frozen copy.
process.env.KV_REST_API_URL = 'https://kv.test/';
process.env.KV_REST_API_TOKEN = 'kvtok';

const KV = new Map();
let delayNextWrite = 0;
globalThis.fetch = async (url, opts = {}) => {
  const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  const args = JSON.parse(opts.body);
  const run = (a) => {
    const c = String(a[0]).toUpperCase(), k = a[1];
    if (c === 'GET') return KV.has(k) ? KV.get(k) : null;
    if (c === 'SET') { KV.set(k, a[2]); return 'OK'; }
    if (c === 'DEL') { const had = KV.has(k); KV.delete(k); return had ? 1 : 0; }
    if (c === 'HSET') { const h = KV.get(k) || {}; h[a[2]] = a[3]; KV.set(k, h); return 1; }
    if (c === 'HGET') { const h = KV.get(k) || {}; return h[a[2]] == null ? null : h[a[2]]; }
    if (c === 'HDEL') { const h = KV.get(k) || {}; const had = a[2] in h; delete h[a[2]]; KV.set(k, h); return had ? 1 : 0; }
    if (c === 'HGETALL') { const h = KV.get(k) || {}; const o = []; for (const [f, v] of Object.entries(h)) o.push(f, v); return o; }
    if (c === 'EXPIRE') return 1;
    throw new Error('unsupported in test: ' + c);
  };
  // Lets a test hold a write open, which is how the interleaving below is made
  // deterministic rather than hoping the event loop cooperates.
  if (delayNextWrite && /HSET|SET/.test(String(args[0] || args[0]?.[0]))) {
    const ms = delayNextWrite; delayNextWrite = 0;
    await new Promise((r) => setTimeout(r, ms));
  }
  if (String(url).endsWith('/pipeline')) return json(args.map((a) => ({ result: run(a) })));
  return json({ result: run(args) });
};

const store = await import('../lib/store.js');
const backup = await import('../lib/backup.js');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };
const reset = () => KV.clear();

console.log('\nTHE RACE THAT WAS CORRUPTING BILLING');

reset();
await store.upsertAccount({ email: 'a@shop.test', name: 'A', ending: {} });
await store.upsertAccount({ email: 'b@shop.test', name: 'B', ending: {} });

// Two different customers cancel a module at the same moment. Under the blob
// this was the bug; each held a full copy and the later write won.
delayNextWrite = 25;   // A's write is held open while B does its whole cycle
await Promise.all([
  store.upsertAccount({ email: 'a@shop.test', ending: { P3: 111 } }),
  (async () => { await new Promise((r) => setTimeout(r, 5)); return store.upsertAccount({ email: 'b@shop.test', ending: { P9: 222 } }); })(),
]);

const a = await store.getAccount('a@shop.test');
const b = await store.getAccount('b@shop.test');
check("A's cancellation survived", a && a.ending && a.ending.P3 === 111, JSON.stringify(a && a.ending));
check("B's cancellation survived", b && b.ending && b.ending.P9 === 222, JSON.stringify(b && b.ending));
check('and neither lost their name', a.name === 'A' && b.name === 'B', JSON.stringify([a.name, b.name]));

// Proof it is structural, not luck: they are stored under separate keys, so one
// write physically cannot carry the other's data.
const hash = KV.get('ks:acct');
check('each account is its own field, which is WHY the race is gone',
  hash && hash['a@shop.test'] && hash['b@shop.test'], JSON.stringify(Object.keys(hash || {})));
check('and the old single blob is not written at all', !KV.has('ks:accounts'));

console.log('\nREADING ONE CUSTOMER DOES NOT READ THEM ALL');

reset();
const many = {};
for (let i = 0; i < 50; i++) many['shop' + i + '@test.com'] = { email: 'shop' + i + '@test.com', name: 'Shop ' + i };
await store.saveAccounts(many);
let reads = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => { reads.push(JSON.parse(o.body)); return realFetch(u, o); };
await store.getAccount('shop7@test.com');
globalThis.fetch = realFetch;
check('one account is one HGET, not a read of all fifty',
  reads.length === 1 && reads[0][0] === 'HGET', JSON.stringify(reads));

console.log('\nTODAY\'S LIVE DATA MUST SURVIVE THE CHANGE');

// This is the part that protects real customers on the day it deploys. Their
// accounts are in the old blob and nothing runs a migration by hand.
reset();
KV.set('ks:accounts', JSON.stringify({
  'live1@shop.test': { email: 'live1@shop.test', name: 'Live One', stripeCustomerId: 'cus_1', tokenNonce: 'n1' },
  'live2@shop.test': { email: 'live2@shop.test', name: 'Live Two', ending: { P3: 999 } },
}));

const one = await store.getAccount('live2@shop.test');
check('a single account is found in the old blob and returned',
  one && one.name === 'Live Two' && one.ending.P3 === 999, JSON.stringify(one));
check('and carried forward into the new shape, so the next read is cheap',
  !!(KV.get('ks:acct') || {})['live2@shop.test']);

reset();
KV.set('ks:accounts', JSON.stringify({
  'live1@shop.test': { email: 'live1@shop.test', name: 'Live One', stripeCustomerId: 'cus_1' },
  'live2@shop.test': { email: 'live2@shop.test', name: 'Live Two' },
}));
const all = await store.getAccounts();
check('every account migrates on the first full read', Object.keys(all).length === 2, JSON.stringify(Object.keys(all)));
check('with their fields intact', all['live1@shop.test'].stripeCustomerId === 'cus_1');
check('and they are in the hash afterwards', Object.keys(KV.get('ks:acct') || {}).length === 2);

// A customer who signs up during the rollout must not vanish when the rest migrate.
reset();
KV.set('ks:accounts', JSON.stringify({ 'old@shop.test': { email: 'old@shop.test', name: 'Old' } }));
await store.upsertAccount({ email: 'new@shop.test', name: 'New' });
const mixed = await store.getAccounts();
check('a brand new account is not lost when old ones are still in the blob',
  !!mixed['new@shop.test'], JSON.stringify(Object.keys(mixed)));
check('and the old one still resolves', !!(await store.getAccount('old@shop.test')));

console.log('\nA PARTIAL WRITE MUST NOT DELETE EVERYONE ELSE');

// The old saveAccounts replaced the whole set with whatever it was handed, so a
// caller passing a partial map deleted every customer missing from it.
reset();
await store.saveAccounts({
  'keep1@shop.test': { email: 'keep1@shop.test', name: 'Keep 1' },
  'keep2@shop.test': { email: 'keep2@shop.test', name: 'Keep 2' },
});
await store.saveAccounts({ 'keep1@shop.test': { email: 'keep1@shop.test', name: 'Keep 1 edited' } });
const after = await store.getAccounts();
check('the account that was not mentioned is still there', !!after['keep2@shop.test'], JSON.stringify(Object.keys(after)));
check('and the one that was mentioned is updated', after['keep1@shop.test'].name === 'Keep 1 edited');

console.log('\nTHE SWEEP MUST NOT UNDO A CUSTOMER\'S OWN CANCELLATION');

// sweepExpired reads every account, then makes a network call per expiry, so it
// can be running for a while. It used to write the whole set back at the end,
// stomping anything a customer changed in the meantime.
reset();
const past = Math.floor(Date.now() / 1000) - 100;
await store.saveAccounts({
  'exp@shop.test': { email: 'exp@shop.test', ending: { P3: past } },
  'busy@shop.test': { email: 'busy@shop.test', ending: {} },
});
const written = [];
const out = await backup.sweepExpired({
  getAccounts: store.getAccounts,
  saveAccounts: async (m) => { written.push(...Object.keys(m)); return store.saveAccounts(m); },
  // A customer flips a switch while the sweep is mid-loop.
  removeModules: async () => { await store.upsertAccount({ email: 'busy@shop.test', ending: { P9: 555 } }); },
});
check('the expired module is swept', out.expired.length === 1 && out.expired[0].email === 'exp@shop.test', JSON.stringify(out.expired));
check('the sweep writes ONLY the account it changed', written.length === 1 && written[0] === 'exp@shop.test', JSON.stringify(written));
const busy = await store.getAccount('busy@shop.test');
check("so the customer's switch flip during the sweep is not erased",
  busy && busy.ending && busy.ending.P9 === 555, JSON.stringify(busy && busy.ending));

console.log('\nTHE BACKUP MUST CAPTURE LIVE ACCOUNTS, NOT A FROZEN COPY');

// backup.js read 'ks:accounts' directly. That blob is never written again, so
// after the split it would have snapshotted the day-of-migration data for ever
// while reporting success. You only find out on the day you need it.
reset();
KV.set('ks:siteidx', { 'a-shop': JSON.stringify({ business: 'A Shop' }) });
KV.set('ks:site:a-shop', JSON.stringify({ slug: 'a-shop', business: 'A Shop' }));
KV.set('ks:accounts', JSON.stringify({ 'stale@shop.test': { email: 'stale@shop.test', name: 'STALE' } }));
await store.upsertAccount({ email: 'current@shop.test', name: 'CURRENT' });
await backup.runBackup(new Date('2026-08-21T03:30:00Z'));
const snap = JSON.parse(KV.get('ks:backup:2026-08-21'));
check('the backup contains the account that exists now',
  !!(snap.accounts && snap.accounts['current@shop.test']), JSON.stringify(Object.keys(snap.accounts || {})));
check('and the site records are still captured', !!snap.sites['a-shop']);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
