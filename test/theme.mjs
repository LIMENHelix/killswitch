// THE LOOK PICKER, AND THE PROMISE THAT IT CANNOT TOUCH ANYONE'S BILL.
//
// Two things are being proved here, and the second matters more than the first.
//
// 1. A customer can choose one of five looks for their own website, free, and it
//    actually changes what api/site.js serves.
// 2. It is WALLED OFF FROM BILLING. api/theme.js imports no Stripe, no prices
//    and no entitlements, it cannot be reached without a panel token, it cannot
//    be pointed at somebody else's site, and setting a theme leaves the module
//    list and the account untouched. Everything the panel did before goes
//    through api/switch.js, which reconciles real subscriptions; a colour picker
//    must never be able to get in there.
//
// Runs the REAL api/theme.js over a fake Redis. No network, no Stripe, no email.
import path from 'node:path';
import fs from 'node:fs';
const ROOT = path.join(import.meta.dirname, '..');

process.env.KV_REST_API_URL = 'https://kv.test/';
process.env.KV_REST_API_TOKEN = 'kvtok';
process.env.KS_PANEL_SECRET = 'panelsecret';

const KV = new Map();
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (!u.startsWith('https://kv.test')) throw new Error('unexpected network call in theme test: ' + u);
  const args = JSON.parse(opts.body);
  const run = (a) => {
    const [c, key, f, v] = a;
    if (c === 'GET') return KV.has(key) ? KV.get(key) : null;
    if (c === 'SET' && String(a[3]).toUpperCase() === 'NX') { if (KV.has(key)) return null; KV.set(key, f); return 'OK'; }
    if (c === 'SET') { KV.set(key, v === undefined ? f : v); return 'OK'; }
    if (c === 'HSET') { const h = KV.get(key) || {}; h[f] = v; KV.set(key, h); return 1; }
    if (c === 'HGET') { const h = KV.get(key) || {}; return h[f] == null ? null : h[f]; }
    if (c === 'HDEL') { const h = KV.get(key) || {}; delete h[f]; KV.set(key, h); return 1; }
    if (c === 'HGETALL') { const h = KV.get(key) || {}; const o = []; for (const [k, val] of Object.entries(h)) o.push(k, val); return o; }
    if (c === 'HKEYS') return Object.keys(KV.get(key) || {});
    if (c === 'INCR') { const n = Number(KV.get(key) || 0) + 1; KV.set(key, String(n)); return n; }
    if (c === 'DEL') { KV.delete(key); return 1; }
    if (c === 'EXPIRE') return 1;
    throw new Error('unexpected kv cmd ' + c);
  };
  if (u.endsWith('/pipeline')) return json(args.map((a) => ({ result: run(a) })));
  return json({ result: run(args) });
};

const theme = (await import('../api/theme.js')).default;
const siteApi = (await import('../api/site.js')).default;
const { upsertAccount, getAccount } = await import('../lib/store.js');
const { upsertSite, getSite, SITE_DEFAULT } = await import('../lib/sites.js');
const { panelToken } = await import('../lib/panel-auth.js');
const { renderSite, THEMES, THEME_NAMES, onAccent, themeFor, FACTORY_ACCENT } = await import('../lib/site-template.js');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

function mkRes() {
  const r = { code: 0, body: null, headers: {}, sent: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  r.send = (s) => { r.sent = s; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
const req = (body, method = 'POST') => ({ method, body, query: {}, headers: { host: 'killswitchwebsites.com', 'x-forwarded-for': '198.51.100.7' } });
const call = async (body, method) => { const r = mkRes(); await theme(req(body, method), r); return r; };

// --- two customers, so "cannot touch somebody else's site" is testable --------
const MINE = 'dave@davesauto.test', THEIRS = 'mike@mesaroofing.test';
await upsertAccount({ email: MINE, name: "Dave's Auto", site: "Dave's Auto", plan: ['P0'] });
await upsertAccount({ email: THEIRS, name: 'Mesa Roofing', site: 'Mesa Roofing', plan: ['P0'] });
await upsertSite({ business: "Dave's Auto", email: MINE, published: true, claimed: true, phone: '(816) 555-0142' });
await upsertSite({ business: 'Mesa Roofing', email: THEIRS, published: true, claimed: true });
const tokMine = await panelToken(MINE);

console.log('\nTHE DOOR IS SHUT TO EVERYONE WITHOUT A PANEL LINK');
check('no token is refused', (await call({ e: MINE, t: 'nope', action: 'list' })).code === 401);
check('no email is refused', (await call({ t: tokMine, action: 'list' })).code === 401);
check('another customer\'s token cannot be used', (await call({ e: THEIRS, t: tokMine, action: 'list' })).code === 401);
check('GET is refused, so the URL is not a drive-by', (await call({}, 'GET')).code === 405);
// An email with no account cannot even OBTAIN a token: panelToken reads a
// per-account nonce and returns '' without one (lib/panel-auth.js:87). So the
// refusal happens one step earlier than the handler's own 404, which stays as
// defence in depth for an account deleted after its link was sent.
check('an unknown email cannot even get a panel token', (await panelToken('ghost@nowhere.test')) === '');
check('and it is refused at the door', (await call({ e: 'ghost@nowhere.test', t: 'anything', action: 'list' })).code === 401);

console.log('\nTHE PICKER OFFERS EXACTLY WHAT WE SHIP');
const listed = await call({ e: MINE, t: tokMine, action: 'list' });
check('list returns 200', listed.code === 200, String(listed.code));
check('every theme we ship is offered', listed.body.themes.length === THEME_NAMES.length, JSON.stringify(listed.body.themes.map((t) => t.id)));
check('a site that never chose one reads as the original look', listed.body.current === 'warm', listed.body.current);
check('each option carries a drawable swatch',
  listed.body.themes.every((t) => /^#|^rgba/.test(t.swatch.bg) && /^#/.test(t.swatch.ac) && /^#/.test(t.swatch.ink)));
check('each option carries a label and a plain-English note',
  listed.body.themes.every((t) => t.label && t.note));

console.log('\nCHOOSING ONE ACTUALLY CHANGES THE WEBSITE');
const set = await call({ e: MINE, t: tokMine, action: 'set', theme: 'midnight' });
check('set returns 200 and reports the new look', set.code === 200 && set.body.current === 'midnight', JSON.stringify(set.body));
check('it is written to the site record', (await getSite('daves-auto')).theme === 'midnight', (await getSite('daves-auto')).theme);
const res5 = mkRes();
await siteApi({ method: 'GET', query: { slug: 'daves-auto' }, headers: { host: 'killswitchwebsites.com' } }, res5);
check('the LIVE page is served with the dark background', res5.code === 200 && res5.sent.includes('--bg:' + THEMES.midnight.bg), String(res5.code));
check('and with the theme\'s own accent, not the old green',
  res5.sent.includes('--ac:' + THEMES.midnight.ac) && !res5.sent.includes('--ac:' + FACTORY_ACCENT));
const back = await call({ e: MINE, t: tokMine, action: 'set', theme: 'warm' });
check('set warm returns 200', back.code === 200 && back.body.current === 'warm');
const res6 = mkRes();
await siteApi({ method: 'GET', query: { slug: 'daves-auto' }, headers: { host: 'killswitchwebsites.com' } }, res6);
check('the live page is the original cream and green again',
  res6.sent.includes('--bg:#F6F1E7') && res6.sent.includes('--ac:' + FACTORY_ACCENT));

console.log('\nA CUSTOMER CANNOT RESTYLE SOMEBODY ELSE\'S WEBSITE');
const beforeTheirs = (await getSite('mesa-roofing')).theme;
await call({ e: MINE, t: tokMine, action: 'set', theme: 'bold', slug: 'mesa-roofing' });
check('naming another slug in the body is ignored', (await getSite('mesa-roofing')).theme === beforeTheirs,
  String((await getSite('mesa-roofing')).theme));
check('the change landed on their OWN site instead', (await getSite('daves-auto')).theme === 'bold');

console.log('\nJUNK IS REFUSED RATHER THAN STORED');
const bad = await call({ e: MINE, t: tokMine, action: 'set', theme: 'hot-pink-comic-sans' });
check('an unknown theme is a 400', bad.code === 400 && bad.body.error === 'unknown_theme', JSON.stringify(bad.body));
check('and the site keeps the theme it had', (await getSite('daves-auto')).theme === 'bold');
check('an unknown ACTION is a 400', (await call({ e: MINE, t: tokMine, action: 'destroy' })).code === 400);
check('a theme name that is not a string does not crash it',
  (await call({ e: MINE, t: tokMine, action: 'set', theme: { evil: true } })).code === 400);

console.log('\nIT IS FREE, AND IT CANNOT REACH THE BILLING ENGINE');
const src = fs.readFileSync(path.join(ROOT, 'api', 'theme.js'), 'utf8');
// The IMPORTS are what can reach billing. The word 'Stripe' in a comment
// explaining why this file stays away from it is the opposite of a problem.
const imports = src.split(/\r?\n/).filter((l) => /^import /.test(l)).join('\n');
check('api/theme.js imports no Stripe', !/stripe/i.test(imports), imports);
check('api/theme.js imports no price table', !/prices\.js/.test(imports));
check('api/theme.js imports no entitlements', !/entitle\.js/.test(imports));
check('and it never mentions a phase code, so a theme can never be sold', !/\bP\d+\b/.test(src));
const acct = await getAccount(MINE);
check('the account plan is untouched by picking a look', JSON.stringify(acct.plan) === JSON.stringify(['P0']), JSON.stringify(acct.plan));
check('no stripe customer was invented', !acct.stripeCustomerId);
check('the site module list is untouched', JSON.stringify((await getSite('daves-auto')).modules) === JSON.stringify(['P0']),
  JSON.stringify((await getSite('daves-auto')).modules));
const prices = fs.readFileSync(path.join(ROOT, 'lib', 'prices.js'), 'utf8');
check('nothing named theme was added to the price table', !/theme/i.test(prices));

console.log('\nNO CUSTOMER CAN PRODUCE AN UNREADABLE BUTTON');
check('white text on the original deep green', onAccent(FACTORY_ACCENT) === '#fff');
check('dark text on a bright yellow', onAccent('#FFE01B') === '#111111', onAccent('#FFE01B'));
check('dark text on a pale pink', onAccent('#F8C8DC') === '#111111', onAccent('#F8C8DC'));
check('white text on a navy', onAccent('#0B2545') === '#fff');
check('junk falls back to white rather than throwing', onAccent('nonsense') === '#fff' && onAccent(null) === '#fff');
check('every theme we ship pairs its accent with readable text',
  THEME_NAMES.every((n) => {
    const html = renderSite({ ...SITE_DEFAULT, business: 'X', slug: 'x', accent: FACTORY_ACCENT, theme: n }, {});
    return html.includes('--on:' + onAccent(THEMES[n].ac));
  }));

console.log('\nA COLOUR SOMEBODY DELIBERATELY SET STILL WINS');
const custom = renderSite({ ...SITE_DEFAULT, business: 'X', slug: 'x', accent: '#7C3AED', theme: 'midnight' }, {});
check('an operator-set brand colour survives a theme change', custom.includes('--ac:#7C3AED'));
check('but the theme still supplies the rest of the palette', custom.includes('--bg:' + THEMES.midnight.bg));
check('and the text on that colour is still readable', custom.includes('--on:' + onAccent('#7C3AED')));

console.log('\nA SITE WITH NO WEBSITE YET IS TOLD THE TRUTH');
await upsertAccount({ email: 'new@nobody.test', name: 'Brand New', plan: ['P0'] });
const orphan = await call({ e: 'new@nobody.test', t: await panelToken('new@nobody.test'), action: 'list' });
check('it still returns 200 with the catalogue', orphan.code === 200 && orphan.body.themes.length === THEME_NAMES.length);
check('it says plainly that there is no site yet', orphan.body.noSite === true);
check('and it does not pretend a theme is applied', orphan.body.current === 'warm');

console.log('\nTHE FALLBACK IS ALWAYS THE ORIGINAL LOOK');
check("themeFor('') is warm", themeFor('') === THEMES.warm);
check('themeFor(undefined) is warm', themeFor(undefined) === THEMES.warm);
check('themeFor(garbage) is warm', themeFor('../../etc/passwd') === THEMES.warm);
check('theme names are matched case-insensitively', themeFor('MIDNIGHT') === THEMES.midnight);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
