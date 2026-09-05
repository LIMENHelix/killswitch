process.env.KV_REST_API_URL = 'https://kv.scorecard.test/';
process.env.KV_REST_API_TOKEN = 'token';
process.env.ADMIN_KEY = 'owner-key';
process.env.CRON_SECRET = 'cron-secret';
process.env.RESEND_API_KEY = 'resend-key';
process.env.KS_NOTIFY_EMAIL = 'owner@example.com';
delete process.env.VERCEL_ENV;

const KV = new Map();
const emails = [];
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.startsWith('https://kv.scorecard.test')) {
    const input = JSON.parse(options.body);
    const run = (args) => {
      const [op, key, value] = args;
      if (op === 'GET') return KV.get(key) ?? null;
      if (op === 'HGETALL') return [];
      if (op === 'SET' && args[3] === 'NX') {
        if (KV.has(key)) return null;
        KV.set(key, value); return 'OK';
      }
      if (op === 'SET') { KV.set(key, value); return 'OK'; }
      if (op === 'DEL') { KV.delete(key); return 1; }
      throw new Error('unexpected command ' + op);
    };
    const result = target.endsWith('/pipeline')
      ? input.map((args) => ({ result: run(args) }))
      : { result: run(input) };
    return { ok: true, status: 200, json: async () => result };
  }
  if (target === 'https://api.resend.com/emails') {
    emails.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ id: 'email_1' }), text: async () => '' };
  }
  throw new Error('unexpected fetch ' + target);
};

const handler = (await import('../api/cron-scorecard.js')).default;
function response() {
  const out = { code: 0, body: null };
  out.status = (code) => { out.code = code; return out; };
  out.json = (body) => { out.body = body; return out; };
  return out;
}
async function call(query = {}, authorization = '') {
  const res = response();
  await handler({ method: 'GET', query, headers: { authorization } }, res);
  return res;
}

let passed = 0, failed = 0;
function check(name, condition, detail = '') {
  if (condition) { console.log('  PASS  ' + name); passed++; }
  else { console.log('  FAIL  ' + name + (detail ? ' <- ' + detail : '')); failed++; }
}

console.log('\nTHE WEEKLY EMAIL IS OWNER-GATED AND IDEMPOTENT');
let result = await call();
check('an unauthenticated caller is refused', result.code === 401);
result = await call({ token: 'wrong' });
check('a wrong owner key is refused', result.code === 401);
result = await call({ token: 'owner-key' });
check('the owner can run the report manually', result.code === 200 && result.body.sent === true, JSON.stringify(result.body));
check('one report sends one email', emails.length === 1);
check('the email names the scorecard', emails[0].subject.includes('Weekly Killswitch scorecard'));
check('the empty system reports zero instead of inventing activity', result.body.report.acquisition.validSignups === 0 && result.body.report.economics.trackedSpendCents === 0);
check('the sent report is retained for Master/audit use', KV.has('ks:scorecard:last'));
result = await call({ token: 'owner-key' });
check('a retry for the same week is a no-op', result.code === 200 && result.body.duplicate === true);
check('the retry sends no second email', emails.length === 1);

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
