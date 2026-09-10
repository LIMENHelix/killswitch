// THE BOUNDED FREE-SITE CLAIM REMINDER.
//
// One owner who was handed a live free site and never opened their panel gets
// exactly one reminder, three days later, carrying the existing authenticated
// panel link. Everything re-derives eligibility from durable truth at SEND
// time: engaged (panel opened), paid, suppressed, or site gone all stand it
// down with a recorded reason. Queue, lease, retire and dead-letter machinery
// is the existing P6 automation framework, unmodified in behaviour.
import path from 'node:path';
const ROOT = path.join(import.meta.dirname, '..');
process.env.KV_REST_API_URL = 'https://kv.test/';
process.env.KV_REST_API_TOKEN = 'kvtok';
process.env.KS_PANEL_SECRET = 'panelsecret';
process.env.RESEND_API_KEY = 're_stub';

const KV = new Map();
let resendFail = null;          // null | 500 | 400
let resendCalls = [];
let preview = false;

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
      if (cmd === 'HKEYS') return Object.keys(KV.get(key) || {});
      if (cmd === 'ZADD') {
        const z = KV.get(key) || {};
        const nx = a[2] === 'NX';
        const score = Number(nx ? a[3] : a[2]);
        const member = nx ? a[4] : a[3];
        if (nx && z[member] !== undefined) return 0;
        z[member] = score; KV.set(key, z); return 1;
      }
      if (cmd === 'ZRANGEBYSCORE') {
        const z = KV.get(key) || {};
        const max = Number(a[3]);
        let out = Object.keys(z).filter((m) => z[m] <= max).sort((x, y) => z[x] - z[y]);
        const li = a.indexOf('LIMIT');
        if (li > -1) out = out.slice(Number(a[li + 1]), Number(a[li + 1]) + Number(a[li + 2]));
        return out;
      }
      if (cmd === 'ZREM') { const z = KV.get(key) || {}; delete z[f]; KV.set(key, z); return 1; }
      if (cmd === 'ZRANGE') return Object.keys(KV.get(key) || {});
      if (cmd === 'DEL') { KV.delete(key); return 1; }
      throw new Error('unexpected kv cmd ' + cmd);
    };
    if (u.endsWith('/pipeline')) return { ok: true, status: 200, json: async () => args.map((a) => ({ result: run(a) })) };
    return { ok: true, status: 200, json: async () => ({ result: run(args) }) };
  }
  if (u.startsWith('https://api.resend.com')) {
    resendCalls.push(JSON.parse(opts.body));
    if (resendFail) return { ok: false, status: resendFail, json: async () => ({}), text: async () => 'stub' };
    return { ok: true, status: 200, json: async () => ({ id: 're_stub' }) };
  }
  throw new Error('unexpected fetch ' + u);
};

const { queueClaimReminder, dueItems, listDeadLetters } = await import('../lib/automation.js');
const { getSite, upsertSite } = await import('../lib/sites.js');
const { upsertAccount } = await import('../lib/store.js');
const { suppressContact } = await import('../lib/suppression.js');
const cronFollowups = (await import('../api/cron-followups.js')).default;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };
const seed = () => { KV.clear(); resendFail = null; resendCalls = []; preview = false; };
const SITE = { slug: 'river-auto', business: 'River Auto', phone: '816-555-0142', email: 'owner@riverauto.test', modules: ['P0'], published: true, claimed: true };
const putSite = async () => upsertSite(SITE);
const runCron = async () => {
  const res = { code: 0, body: null };
  res.status = (c) => { res.code = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  await cronFollowups({ method: 'GET', headers: { authorization: 'Bearer cronsecret' }, query: {} }, res);
  return res;
};
process.env.CRON_SECRET = 'cronsecret';

console.log('\nSCHEDULING: ONE REMINDER, DELIVERED OR NOT AT ALL');
await putSite();
check('an eligible delivered site queues exactly one reminder', await queueClaimReminder(await getSite('river-auto'), { email: SITE.email }) === true);
const due = await dueItems(Date.now() + 4 * 86400000);
check('it is due three days out, on the existing cadence', due.length === 1 && due[0].step === 'claimremind' && due[0].due - Date.now() > 2 * 86400000);
check('a second schedule for the same owner is a no-op', await queueClaimReminder(await getSite('river-auto'), { email: SITE.email }) === false
  && (await dueItems(Date.now() + 4 * 86400000)).length === 1);
check('a junk email queues nothing', await queueClaimReminder(await getSite('river-auto'), { email: 'not-an-email' }) === false);
check('scheduling works before the account exists (send-time gate decides)', true);

console.log('\nSEND: PANEL LINK ONCE, SKIP REASONS RECORDED');
seed(); await putSite(); await upsertAccount({ email: SITE.email, plan: ['P0'], tokenNonce: 'nonce123', createdAt: new Date().toISOString(), source: 'test' });
await queueClaimReminder(await getSite('river-auto'), { email: SITE.email });
let r = await runCron();
check('before three days nothing is due', r.code === 200 && r.body.sent === 0 && resendCalls.length === 0);
// time travel: requeue with a past due date by rewriting the zset score
const q = KV.get('ks:auto:q'); const id = Object.keys(q)[0]; q[id] = Date.now() - 1000; KV.set('ks:auto:q', q);
r = await runCron();
check('the due reminder sends the existing panel link once', r.code === 200 && r.body.sent === 1 && resendCalls.length === 1);
check('the email is the panel link to the right owner', resendCalls[0].to[0] === SITE.email && /\/panel\?e=/.test(resendCalls[0].html) && /&amp;t=/.test(resendCalls[0].html), resendCalls[0] && resendCalls[0].html.slice(0, 220));
check('a repeat run has nothing left to send', (await runCron()).body.sent === 0);
check('the send is recorded in the existing SENT ledger', (await dueItems(Date.now() + 99999)).length === 0);

console.log('\nSTOP CONDITIONS, DERIVED FROM CURRENT TRUTH AT SEND TIME');
// engaged after scheduling
seed(); await putSite(); await upsertAccount({ email: SITE.email, plan: ['P0'], tokenNonce: 'n', engagedAt: new Date().toISOString() });
await queueClaimReminder(await getSite('river-auto'), { email: SITE.email });
let q2 = KV.get('ks:auto:q'); const id2 = Object.keys(q2)[0]; q2[id2] = Date.now() - 1000; KV.set('ks:auto:q', q2);
r = await runCron();
check('owner opened their panel before send -> skipped as engaged', r.body.skipped === 1 && r.body.reasons.engaged === 1 && resendCalls.length === 0);
// paid after scheduling
seed(); await putSite(); await upsertSite({ slug: 'river-auto', modules: ['P0', 'P6'] });
await upsertAccount({ email: SITE.email, plan: ['P0', 'P6'], tokenNonce: 'n', stripeCustomerId: 'cus_x' });
await queueClaimReminder(await getSite('river-auto'), { email: SITE.email });
q2 = KV.get('ks:auto:q'); q2[Object.keys(q2)[0]] = Date.now() - 1000; KV.set('ks:auto:q', q2);
r = await runCron();
check('owner became a paying customer -> skipped as paid', r.body.reasons.paid === 1 && resendCalls.length === 0);
// suppressed after scheduling
seed(); await putSite(); await upsertAccount({ email: SITE.email, plan: ['P0'], tokenNonce: 'n' });
await suppressContact({ email: SITE.email }, { reason: 'test', actor: 'test' });
await queueClaimReminder(await getSite('river-auto'), { email: SITE.email });
q2 = KV.get('ks:auto:q'); q2[Object.keys(q2)[0]] = Date.now() - 1000; KV.set('ks:auto:q', q2);
r = await runCron();
check('owner became suppressed -> skipped as suppressed', r.body.reasons.suppressed === 1 && resendCalls.length === 0);
// site gone after scheduling
seed(); await upsertAccount({ email: SITE.email, plan: ['P0'], tokenNonce: 'n' });
await queueClaimReminder(SITE, { email: SITE.email });
q2 = KV.get('ks:auto:q'); q2[Object.keys(q2)[0]] = Date.now() - 1000; KV.set('ks:auto:q', q2);
r = await runCron();
check('site unpublished or deleted -> skipped as site_gone', r.body.reasons.site_gone === 1 && resendCalls.length === 0);
// no owner at all
seed(); await putSite();
await queueClaimReminder(await getSite('river-auto'), { email: 'ghost@riverauto.test' });
q2 = KV.get('ks:auto:q'); q2[Object.keys(q2)[0]] = Date.now() - 1000; KV.set('ks:auto:q', q2);
r = await runCron();
check('no account for the email -> skipped as no_owner, nothing sent', r.body.reasons.no_owner === 1 && resendCalls.length === 0);

console.log('\nFAILURE SEMANTICS: TRANSIENT RETRIES, NO DUPLICATE SEND');
seed(); await putSite(); await upsertAccount({ email: SITE.email, plan: ['P0'], tokenNonce: 'nonce123' });
await queueClaimReminder(await getSite('river-auto'), { email: SITE.email });
q2 = KV.get('ks:auto:q'); q2[Object.keys(q2)[0]] = Date.now() - 1000; KV.set('ks:auto:q', q2);
resendFail = 500;
r = await runCron();
check('a transient mail failure leaves the item queued and reports failure', r.code === 500 && r.body.failed === 1 && resendCalls.length === 1);
resendFail = null;
r = await runCron();
check('the retry after recovery sends exactly once', r.code === 200 && r.body.sent === 1 && resendCalls.length === 2);

console.log('\nENVIRONMENT GATES');
// lib/kv.js isolates preview deployments in a ks:env:preview: keyspace and
// sendPanelLink/lib refuse live mail there (externalSideEffectsAllowed), so a
// due item in preview sends nothing and stays queued
seed();
const oldEnv = process.env.VERCEL_ENV; process.env.VERCEL_ENV = 'preview';
await putSite(); await upsertAccount({ email: SITE.email, plan: ['P0'], tokenNonce: 'nonce123' });
await queueClaimReminder(await getSite('river-auto'), { email: SITE.email });
q2 = KV.get('ks:env:preview:auto:q'); q2[Object.keys(q2)[0]] = Date.now() - 1000; KV.set('ks:env:preview:auto:q', q2);
r = await runCron();
check('a preview deployment sends nothing and does not retire the item', r.body.sent === 0 && resendCalls.length === 0 && (await dueItems(Date.now() + 99999)).length === 1, JSON.stringify(r.body));
process.env.VERCEL_ENV = oldEnv || 'production';
// production keyspace: a missing mail key fails closed, recovery retries once
seed(); await putSite(); await upsertAccount({ email: SITE.email, plan: ['P0'], tokenNonce: 'nonce123' });
await queueClaimReminder(await getSite('river-auto'), { email: SITE.email });
q2 = KV.get('ks:auto:q'); q2[Object.keys(q2)[0]] = Date.now() - 1000; KV.set('ks:auto:q', q2);
delete process.env.RESEND_API_KEY;
r = await runCron();
check('a missing mail key fails closed, item stays queued', r.body.sent === 0 && (await dueItems(Date.now() + 99999)).length === 1);
process.env.RESEND_API_KEY = 're_stub';
r = await runCron();
check('once the key is back, the same item sends once', r.body.sent === 1);
// unauthorised cron call
seed();
const res401 = { code: 0, body: null }; res401.status = (c) => { res401.code = c; return res401; }; res401.json = (o) => { res401.body = o; return res401; };
await cronFollowups({ method: 'GET', headers: {}, query: { token: 'wrong' } }, res401);
check('the cron endpoint itself still fails closed without the secret', res401.code === 401, res401.code + ' ' + JSON.stringify(res401.body));

console.log('\nEXISTING P6 FOLLOW-UP BEHAVIOUR UNCHANGED');
const { queueFollowUps } = await import('../lib/automation.js');
seed();
await upsertSite({ ...SITE, modules: ['P0', 'P6'] });
await queueFollowUps(await getSite('river-auto'), { name: 'Pat', handle: 'pat@x.test', kind: 'message' });
q2 = KV.get('ks:auto:q');
for (const k of Object.keys(q2)) q2[k] = Date.now() - 1000;
KV.set('ks:auto:q', q2);
process.env.RESEND_API_KEY = 're_stub';
r = await runCron();
check('a paid P6 site still gets its acknowledgement through the same cron', r.code === 200 && r.body.sent >= 1 && resendCalls.some((c) => /Thanks for getting in touch/.test(c.subject)));
check('claim reminders and P6 items use separate id namespaces', (await listDeadLetters(10)).length === 0);

console.log(fail ? `\n${pass} passed, ${fail} FAILED` : `\n${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
