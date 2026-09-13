// K6 pre-outreach safety tests for lib/mailer.js
// Verifies the autopilot killswitches, suppression, address checks, and the
// sendPostcard channel adapter without calling real providers.
import path from 'node:path';
const ROOT = path.join(import.meta.dirname, '..');

process.env.KV_REST_API_URL = 'https://kv.mailer.test';
process.env.KV_REST_API_TOKEN = 'mailertok';
process.env.LOB_API_KEY = 'lob_test_key';
process.env.KS_FROM_NAME = 'Killswitch Websites';
process.env.KS_FROM_LINE1 = '123 Main St';
process.env.KS_FROM_CITY = 'Kansas City';
process.env.KS_FROM_STATE = 'KS';
process.env.KS_FROM_ZIP = '64108';
process.env.KS_NOTIFY_EMAIL = 'ops@example.com';
process.env.RESEND_API_KEY = 'resend_test_key';
delete process.env.VERCEL_ENV;

const KV = new Map();
let lobNext = [];         // [{ code, status, id }]
let lobCalls = [];        // captured POST bodies
let resendCalls = [];     // captured notify emails

function kvKey(raw) {
  if (process.env.VERCEL_ENV === 'preview') {
    return 'ks:env:preview:' + raw.slice(3);
  }
  return raw;
}

globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.startsWith(process.env.KV_REST_API_URL)) {
    const args = JSON.parse(options.body);
    const run = (a) => {
      const [cmd, rawKey, ...rest] = a;
      const key = kvKey(rawKey);
      if (cmd === 'GET') return KV.get(key) ?? null;
      if (cmd === 'SET') { KV.set(key, rest[0]); return 'OK'; }
      if (cmd === 'DEL') { KV.delete(key); return 1; }
      if (cmd === 'HGETALL') {
        const h = KV.get(key) || {};
        const flat = [];
        for (const [k, v] of Object.entries(h)) flat.push(k, v);
        return flat;
      }
      if (cmd === 'HSET') {
        const h = KV.get(key) || {};
        h[rest[0]] = rest[1];
        KV.set(key, h);
        return 1;
      }
      if (cmd === 'HGET') {
        const h = KV.get(key) || {};
        return h[rest[0]] == null ? null : h[rest[0]];
      }
      throw new Error('unexpected kv cmd ' + cmd);
    };
    if (u.endsWith('/pipeline')) {
      return { ok: true, status: 200, json: async () => args.map((a) => ({ result: run(a) })) };
    }
    return { ok: true, status: 200, json: async () => ({ result: run(args) }) };
  }
  if (u === 'https://api.lob.com/v1/postcards') {
    const form = new URLSearchParams(options.body);
    const next = lobNext.shift() || { id: 'lob_stub_id' };
    if (next.timeout) {
      const e = new Error('The operation timed out');
      e.name = 'TimeoutError';
      throw e;
    }
    lobCalls.push({
      toName: form.get('to[name]'),
      toStreet: form.get('to[address_line1]'),
      fromName: form.get('from[name]'),
      front: form.get('front'),
      back: form.get('back'),
      idempotency: options.headers['Idempotency-Key'],
    });
    if (next.id) {
      return { ok: true, status: 200, json: async () => ({ id: next.id }) };
    }
    return {
      ok: false, status: next.status || 422,
      json: async () => ({ error: { message: next.message || 'stub error', code: next.code } }),
    };
  }
  if (u === 'https://api.resend.com/emails') {
    resendCalls.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ id: 're_stub' }) };
  }
  throw new Error('unexpected fetch ' + u);
};

const { suppressContact } = await import('../lib/suppression.js');
const { getSite, upsertSite } = await import('../lib/sites.js');
const {
  hasAddr, isMailed, spentToDate, isBad, inQueue,
  lobSend, sendPostcard, COST,
} = await import('../lib/mailer.js');

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { console.log('  PASS  ' + name); pass++; }
  else { console.log('  FAIL  ' + name + (detail ? ' <- ' + detail : '')); fail++; }
}

function seed() {
  KV.clear();
  lobNext = [];
  lobCalls = [];
  resendCalls = [];
}

const lead = (overrides = {}) => ({
  id: 'l1', name: 'River Auto', business: 'River Auto', trade: 'auto repair',
  street: '100 River Rd', city: 'Kansas City', state: 'MO', zip: '64101',
  status: 'ready', ...overrides,
});

console.log('\nADDRESS AND QUEUE PREDICATES');
check('hasAddr is true with street/state/zip', hasAddr(lead()));
check('hasAddr is false without zip', !hasAddr(lead({ zip: '' })));
check('isMailed detects status mailed', isMailed(lead({ status: 'mailed' })));
check('isMailed detects lob_id', isMailed(lead({ lob_id: 'lob_123' })));
check('spentToDate is zero for empty list', spentToDate([]) === 0);
check('spentToDate counts mailed leads', spentToDate([lead(), lead({ status: 'mailed' }), lead({ status: 'mailed' })]) === +(2 * COST).toFixed(2));
check('isBad detects bad_address', isBad(lead({ status: 'bad_address' })));
check('inQueue accepts valid ready lead', inQueue(lead()));
check('inQueue rejects missing address', !inQueue(lead({ street: '' })));
check('inQueue rejects mailed lead', !inQueue(lead({ status: 'mailed' })));
check('inQueue rejects bad_address', !inQueue(lead({ status: 'bad_address' })));
check('inQueue rejects suppressed lead', !inQueue(lead({ suppressed: true })));

console.log('\nLOB SEND SAFETY GATES');
seed();
const baseLead = lead();
await suppressContact(baseLead, { reason: 'opted out', actor: 'test' });
let r = await lobSend(baseLead);
check('lobSend blocks suppressed leads', r.code === 'suppressed' && r.error === 'contact suppressed');

seed();
const noKey = process.env.LOB_API_KEY;
delete process.env.LOB_API_KEY;
r = await lobSend(lead());
check('lobSend fails cleanly when LOB_API_KEY is missing', r.error && r.error.includes('LOB_API_KEY'));
process.env.LOB_API_KEY = noKey;

seed();
const noName = process.env.KS_FROM_NAME;
delete process.env.KS_FROM_NAME;
r = await lobSend(lead());
check('lobSend fails cleanly when return address is missing', r.error && r.error.includes('return address'));
process.env.KS_FROM_NAME = noName;

seed();
r = await lobSend(lead());
check('lobSend returns a provider id on success', r.id === 'lob_stub_id');

seed();
lobNext.push({ code: 'failed_deliverability_strictness', status: 422, message: 'bad address' });
r = await lobSend(lead());
check('lobSend returns bad_address code for failed deliverability', r.code === 'failed_deliverability_strictness');

console.log('\nSEND POSTCARD K6 ADAPTER');
seed();
let a = await sendPostcard({ lead: lead() });
check('sendPostcard returns ok with providerRef on success', a.ok === true && a.providerRef === 'lob_stub_id' && a.spend === Math.round(COST * 100));

seed();
await suppressContact(baseLead, { reason: 'opted out', actor: 'test' });
a = await sendPostcard({ lead: baseLead });
check('sendPostcard reports suppressed', !a.ok && a.reason === 'suppressed' && a.spend === 0);

seed();
lobNext.push({ code: 'failed_deliverability_strictness', status: 422 });
a = await sendPostcard({ lead: lead() });
check('sendPostcard reports bad_address', !a.ok && a.reason === 'bad_address');

seed();
const cfgKey = process.env.LOB_API_KEY;
delete process.env.LOB_API_KEY;
a = await sendPostcard({ lead: lead() });
check('sendPostcard reports config error', !a.ok && String(a.reason).includes('LOB_API_KEY') && !a.retryable);
process.env.LOB_API_KEY = cfgKey;

seed();
lobNext.push({ code: 'internal_server_error', status: 500, message: 'lob server error' });
a = await sendPostcard({ lead: lead() });
check('sendPostcard treats 5xx as retryable and unknown', !a.ok && a.retryable === true && a.unknown === true);

console.log('\nLOB PROVIDER IDEMPOTENCY');
seed();
a = await sendPostcard({ lead: lead(), idempotencyKey: 'oe-test-key:0' });
check('the adapter forwards the durable idempotency key to Lob', a.ok && lobCalls[0].idempotency === 'oe-test-key:0');
seed();
a = await sendPostcard({ lead: lead(), idempotencyKey: 'oe-test-key:0' });
a = await sendPostcard({ lead: lead(), idempotencyKey: 'oe-test-key:0' });
check('a retry of the same logical effect sends the SAME key', lobCalls.length === 2 && lobCalls[0].idempotency === 'oe-test-key:0' && lobCalls[1].idempotency === 'oe-test-key:0');
seed();
r = await lobSend(lead(), undefined, {});
check('a call without a key sends no Idempotency-Key header', r.id === 'lob_stub_id' && lobCalls[0].idempotency === undefined);

console.log('\nPROVIDER TIMEOUT IS UNKNOWN, NEVER SUCCESS');
seed();
lobNext.push({ timeout: true });
a = await sendPostcard({ lead: lead(), idempotencyKey: 'oe-timeout:0' });
check('a timeout is classified unknown and retryable', !a.ok && a.unknown === true && a.retryable === true);
check('a timeout reports no spend and no provider ref', a.spend === 0 && !a.providerRef);
check('the timeout reason is explicit', a.reason === 'provider_timeout');

console.log('\nK5 PRODUCT BOUNDARY: NO IMPLICIT PUBLISH');
seed();
await upsertSite({
  slug: 'river-auto', business: 'River Auto', city: 'Kansas City', state: 'MO',
  modules: ['P0'], claimed: false, published: false,
});
a = await sendPostcard({ lead: lead({ siteSlug: 'river-auto' }), idempotencyKey: 'oe-k5:0' });
check('an unpublished draft makes the send fail closed', !a.ok && a.reason === 'destination_unpublished' && !a.retryable);
check('no Lob call happens for an unpublished destination', lobCalls.length === 0);
let siteAfter = await getSite('river-auto');
check('the draft stays unpublished', siteAfter.published === false);
check('the draft stays unclaimed', siteAfter.claimed === false);
check('the draft modules are unchanged', JSON.stringify(siteAfter.modules) === JSON.stringify(['P0']));

seed();
await upsertSite({
  slug: 'river-auto', business: 'River Auto', city: 'Kansas City', state: 'MO',
  modules: ['P0'], claimed: false, published: true,
});
a = await sendPostcard({ lead: lead({ siteSlug: 'river-auto' }), idempotencyKey: 'oe-k5b:0' });
check('an already-public site may be referenced', a.ok === true);
siteAfter = await getSite('river-auto');
check('the public site is not modified by the send', siteAfter.published === true && siteAfter.claimed === false && JSON.stringify(siteAfter.modules) === JSON.stringify(['P0']));

seed();
a = await sendPostcard({ lead: lead(), idempotencyKey: 'oe-plain:0' });
check('a lead with no draft sends the plain offer card', a.ok === true);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
