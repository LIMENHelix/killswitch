// The ops page lists every internal system. It must never be served without
// an owner key, and a rep key must not open it either.
process.env.ADMIN_KEY = 'ops-owner-test';
process.env.SWITCH_TOKEN = 'ops-switch-test';
process.env.REP_KEYS = 'dana:ops-rep-test';

const { default: handler } = await import('../api/ops.js');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };
const basic = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

function invoke(auth) {
  let status = 200;
  const headers = {};
  let body = '';
  const req = { method: 'GET', headers: auth ? { authorization: auth } : {} };
  const res = {
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    end(v) { body = String(v || ''); },
    set statusCode(v) { status = v; },
    get statusCode() { return status; },
  };
  handler(req, res);
  return { status, headers, body };
}

console.log('\nOPS IS OWNER-ONLY');
const none = invoke(null);
check('no credentials is 401', none.status === 401, String(none.status));
check('it asks the browser for Basic auth', String(none.headers['www-authenticate'] || '').startsWith('Basic'), none.headers['www-authenticate']);
check('it is never cached', String(none.headers['cache-control'] || '').includes('no-store'), none.headers['cache-control']);

const bogus = invoke(basic('admin', 'wrong'));
check('a wrong key is 401', bogus.status === 401, String(bogus.status));

const rep = invoke(basic('admin', 'ops-rep-test'));
check('a rep key cannot open the back end', rep.status === 401, String(rep.status));

const owner = invoke(basic('admin', 'ops-owner-test'));
check('the admin key opens it', owner.status === 200, String(owner.status));
check('and the response is the ops page', owner.body.includes('Operator console.'), owner.body.slice(0, 40));
check('the owner response is not cached', String(owner.headers['cache-control'] || '').includes('no-store'));

const sw = invoke(basic('admin', 'ops-switch-test'));
check('the switch token also opens it', sw.status === 200, String(sw.status));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
