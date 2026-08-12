// WHAT THE AI ACTUALLY COST.
//
// The margin question ("what does a customer cost to run") could only be
// answered from max_tokens caps and prompt lengths, because every Anthropic
// response carried a real `usage` block and every call site threw it away.
// These run the real lib/ai-usage.js over a fake Redis and check the arithmetic,
// the date boundary on Sonnet's introductory pricing, and that a bookkeeping
// failure can never break the reply it is attached to.
process.env.KV_REST_API_URL = 'https://kv.test/';
process.env.KV_REST_API_TOKEN = 'kvtok';

const KV = new Map();
let kvBroken = false;
let roundTrips = 0;
globalThis.fetch = async (url, opts = {}) => {
  roundTrips++;
  if (kvBroken) throw new Error('kv is down');
  const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  const args = JSON.parse(opts.body);
  const run = (a) => {
    const c = String(a[0]).toUpperCase(), k = a[1];
    if (c === 'HINCRBY') {
      const h = KV.get(k) || {}; h[a[2]] = String((Number(h[a[2]]) || 0) + Number(a[3])); KV.set(k, h);
      return Number(h[a[2]]);
    }
    if (c === 'HGETALL') { const h = KV.get(k) || {}; const o = []; for (const [f, v] of Object.entries(h)) o.push(f, v); return o; }
    if (c === 'EXPIRE') return 1;
    throw new Error('unsupported kv command in test: ' + c);
  };
  if (String(url).endsWith('/pipeline')) return json(args.map((a) => ({ result: run(a) })));
  return json({ result: run(args) });
};

const U = await import('../lib/ai-usage.js');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

console.log('\nTHE PRICE THAT WAS IN FORCE ON THE DAY IT HAPPENED');

// Sonnet 5 runs on introductory pricing that ENDS 2026-08-31. Pinning either
// rate would be wrong half the time, so the boundary is the thing to prove.
check('Sonnet is at the intro rate the day before it ends',
  JSON.stringify(U.rateFor('claude-sonnet-5', '2026-08-30')) === JSON.stringify({ in: 2, out: 10, intro: true }),
  JSON.stringify(U.rateFor('claude-sonnet-5', '2026-08-30')));
check('and still on the last day of it, because the date is inclusive',
  U.rateFor('claude-sonnet-5', '2026-08-31').intro === true, JSON.stringify(U.rateFor('claude-sonnet-5', '2026-08-31')));
check('and jumps to standard the very next day',
  JSON.stringify(U.rateFor('claude-sonnet-5', '2026-09-01')) === JSON.stringify({ in: 3, out: 15, intro: false }),
  JSON.stringify(U.rateFor('claude-sonnet-5', '2026-09-01')));
check('models with no intro rate are unaffected by the date',
  U.rateFor('claude-opus-5', '2027-01-01').in === 5 && U.rateFor('claude-haiku-4-5', '2020-01-01').out === 5);

// An unknown model has an UNKNOWN cost, not a free one. A silent zero here would
// quietly understate the bill the moment a model string changes.
check('an unpriced model returns null, never zero', U.costOf({ model: 'claude-whatever-9', inTokens: 1e6, outTokens: 1e6 }) === null);
check('and its rate is null too', U.rateFor('claude-whatever-9') === null);

console.log('\nTHE ARITHMETIC');

check('a million in and a million out on Haiku is $1 + $5',
  near(U.costOf({ model: 'claude-haiku-4-5', inTokens: 1e6, outTokens: 1e6 }), 6), String(U.costOf({ model: 'claude-haiku-4-5', inTokens: 1e6, outTokens: 1e6 })));
check('one real site-assistant answer is about a third of a cent',
  near(U.costOf({ model: 'claude-haiku-4-5', inTokens: 1800, outTokens: 260 }), 0.0018 + 0.0013),
  String(U.costOf({ model: 'claude-haiku-4-5', inTokens: 1800, outTokens: 260 })));
check('one generated site page on Opus is about thirty cents',
  near(U.costOf({ model: 'claude-opus-5', inTokens: 1100, outTokens: 12000 }), 0.0055 + 0.3),
  String(U.costOf({ model: 'claude-opus-5', inTokens: 1100, outTokens: 12000 })));

console.log('\nRECORDING A REAL RESPONSE');

roundTrips = 0;
const r1 = await U.recordUsage({ model: 'claude-haiku-4-5', usage: { input_tokens: 2000, output_tokens: 300 }, where: 'P9-site-assistant' });
check('a response with usage is recorded', r1.recorded === true, JSON.stringify(r1));
check('and priced', near(r1.cost, 0.002 + 0.0015), String(r1.cost));

// This runs between the model answering and the customer seeing the answer.
// Five sequential Upstash calls here is a fifth of a second of bookkeeping
// added to every single chat reply.
check('five counters cost ONE round trip, not five', roundTrips === 1, String(roundTrips));

// Cached input is still input the model read. Counting it keeps the token totals
// true and errs HIGH on dollars, which is the safe direction for a number you
// set prices from.
await U.recordUsage({ model: 'claude-haiku-4-5', usage: { input_tokens: 500, cache_read_input_tokens: 1500, output_tokens: 100 }, where: 'chat' });
let read = await U.readUsage(1);
let h = read.days[0].models['claude-haiku-4-5'];
check('cached input tokens are counted, not dropped', h.in === 2000 + 2000, JSON.stringify(h));
check('output is summed across calls', h.out === 400, JSON.stringify(h));
check('and the call count is real', h.calls === 2, JSON.stringify(h));

check('spend is broken down by WHERE, so a module can be costed on its own',
  read.days[0].byWhere['P9-site-assistant'] === 1 && read.days[0].byWhere.chat === 1, JSON.stringify(read.days[0].byWhere));

// Three models that differ by 25x on output would be meaningless as one number.
await U.recordUsage({ model: 'claude-opus-5', usage: { input_tokens: 1100, output_tokens: 12000 }, where: 'site-writer' });
read = await U.readUsage(1);
check('models are kept apart, not averaged into one AI bill',
  Object.keys(read.days[0].models).sort().join(',') === 'claude-haiku-4-5,claude-opus-5',
  JSON.stringify(Object.keys(read.days[0].models)));
check('the day total is the sum of the models',
  near(read.days[0].usd, Number((0.0035 + 0.0025 + 0.3055).toFixed(4)), 1e-4), String(read.days[0].usd));
check('and one Opus page dwarfs every Haiku answer that day',
  read.days[0].models['claude-opus-5'].usd > read.days[0].models['claude-haiku-4-5'].usd * 20,
  JSON.stringify(read.days[0].models));

console.log('\nBOOKKEEPING MUST NEVER BREAK THE REPLY IT IS ATTACHED TO');

// This is called mid-request, right after the customer's answer comes back. If
// Redis is down, the customer still gets their answer.
kvBroken = true;
const dead = await U.recordUsage({ model: 'claude-haiku-4-5', usage: { input_tokens: 10, output_tokens: 10 }, where: 'chat' });
check('a dead Redis does not throw', dead && dead.recorded === false, JSON.stringify(dead));
const deadRead = await U.readUsage(3);
check('and neither does reading it back', Array.isArray(deadRead.days) && deadRead.totalUsd === 0, JSON.stringify(deadRead));
kvBroken = false;

const empty = await U.recordUsage({ model: 'claude-haiku-4-5', usage: undefined, where: 'chat' });
check('a response with no usage block is skipped, not recorded as zero',
  empty.recorded === false && empty.reason === 'no_usage_block', JSON.stringify(empty));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
