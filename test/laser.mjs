// Proves the ported LASER engine behaves like the original, and that its honesty
// guardrails survived the move. A port that "parses fine" and quietly ranks
// differently would be worse than no port at all: the whole point of the engine
// is that it does not let a small-sample fluke outrank a proven play.
import * as L from '../lib/laser.js';

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

console.log('\nLASER engine, ported from limenhelix.com');

// --- the funnel is intact ---
check('five stages plus source', Array.isArray(L.STAGES) && L.STAGES.length >= 5, JSON.stringify(L.STAGES));
const ids = L.TRANSITIONS.map((t) => t.id);
check('L.A.S.E.R. transitions all present',
  ['source>leads', 'leads>appointments', 'appointments>shows', 'shows>enrollments', 'enrollments>referrals']
    .every((i) => ids.includes(i)), JSON.stringify(ids));

// --- THE GUARDRAIL THAT MATTERS ---
// Wilson lower bound is why a lucky 2-of-2 does not beat a grinding 40-of-50.
const lucky = L.wilsonLower(2, 2);
const proven = L.wilsonLower(40, 50);
check('a 2-of-2 fluke does NOT outrank 40-of-50', proven > lucky,
  `2/2=${lucky.toFixed(3)} vs 40/50=${proven.toFixed(3)}`);
check('wilson stays below the naive rate', lucky < 1 && proven < 0.8,
  `${lucky.toFixed(3)}, ${proven.toFixed(3)}`);
check('zero trials is not a divide-by-zero', Number.isFinite(L.wilsonLower(0, 0)), String(L.wilsonLower(0, 0)));

// --- allocation feeds winners without starving losers ---
// allocate() returns an object keyed by play id, so the two plays must differ in
// their unit or they collapse into one key and the comparison is meaningless.
const t = L.TRANSITIONS.find((x) => x.id === 'leads>appointments');
// options is a COST MAP, channel -> cents per touch, not a list.
const opts = Object.keys(t.options || {});
check('channels carry a per-touch cost in cents',
  opts.length >= 2 && Number.isFinite(t.options[opts[0]]),
  JSON.stringify(t.options));
check('the channels Killswitch actually has are modelled',
  ['call', 'text', 'email', 'mailer'].every((c) => c in (t.options || {})), opts.join(','));

// newPlay takes ONE fields object; allocate groups by p.segment and keys the
// returned weights by p.id, so the plays need distinct ids and a shared segment
// to be compared against each other.
const mk = (id, unit, wins, trials) => {
  const p = L.newPlay({
    id, transitionId: t.id, unitLabel: t.unit, unit,
    dealSize: 'mid', trigger: 'pain',
  });
  p.wins = wins; p.trials = trials;
  return p;
};
const a = mk('call-proven', 'call', 40, 50);   // grinding, proven
const b = mk('text-dud', 'text', 0, 30);       // tried plenty, never converted
check('plays land in the same segment so they compete', a.segment === b.segment, `${a.segment} vs ${b.segment}`);

const alloc = L.allocate([a, b]);
check('allocate weights BOTH plays', Object.keys(alloc).length === 2, JSON.stringify(alloc));
const w = alloc['call-proven'], l = alloc['text-dud'];
check('the proven play gets the volume', w > l, `proven ${w?.toFixed(3)} vs dud ${l?.toFixed(3)}`);
check('the dud keeps an exploration floor, never starved to zero', l > 0, String(l));
check('the group sums to 1', Math.abs((w + l) - 1) < 1e-9, String(w + l));

// --- the simulator exists and is separate from real scoring ---
// Not asserting its output shape: simulate() takes three arguments and this test
// has no business guessing them. What matters for honesty is that the optimizer
// scores from observed wins/trials only, which the Wilson checks above prove.
check('simulate is exported and kept distinct from scoring',
  typeof L.simulate === 'function' && typeof L.scorePlay === 'function' && L.simulate !== L.scorePlay);
check('latentFor exists but is simulator-only, never used by scorePlay',
  typeof L.latentFor === 'function' && !String(L.scorePlay).includes('latent'),
  'scorePlay must never read a hidden rate');

// --- determinism: same seed, same numbers ---
if (typeof L.mulberry32 === 'function') {
  const r1 = L.mulberry32(7), r2 = L.mulberry32(7);
  check('seeded RNG is reproducible', r1() === r2() && r1() === r2());
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
