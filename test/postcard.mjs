// WHAT IS ACTUALLY PRINTED ON THE CARD.
//
// KS_PHONE was empty in production and the card rendered the phone block only
// when it was set, so every postcard mailed so far carried no number to call.
// This is physical mail: a wrong card is a stamp, a print run and a week before
// anyone notices. These read the rendered HTML rather than the code.
const P = await import('../lib/postcard.js');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

const LEAD = { name: "Oou Wee's Barbershop", trade: 'salon/barber' };
const front = P.frontHtml(LEAD);
const back = P.backHtml(LEAD);
const delivered = P.frontHtml({ ...LEAD, siteUrl: 'killswitchwebsites.com/s/oouwees' });
const deliveredBack = P.backHtml({ ...LEAD, siteUrl: 'killswitchwebsites.com/s/oouwees' });

console.log('\nBOTH NUMBERS ARE ON THE CARD');

for (const num of ['913-948-3747', '913-933-1687']) {
  check(num + ' is on the front of the offer card', front.includes(num));
  check(num + ' is on the back of the offer card', back.includes(num));
  check(num + ' is on the front of the delivery card', delivered.includes(num));
  check(num + ' is on the back of the delivery card', deliveredBack.includes(num));
}

// The env var was empty, which is exactly why this needs to hold with NOTHING set.
check('the numbers survive an unset KS_PHONE, which is the state production was in',
  !process.env.KS_PHONE && front.includes('913-948-3747'), 'KS_PHONE=' + String(process.env.KS_PHONE));

console.log('\nTHEY READ AS TWO NUMBERS, NOT ONE RUN-ON');

check('the front puts each on its own line', (front.match(/class="n"/g) || []).length === 2,
  String((front.match(/class="n"/g) || []).length));
check('and shrinks the type so two lines still fit the corner', front.includes('font-size:25px'),
  (front.match(/\.ph \.n\{[^}]*\}/) || [''])[0]);
check('the back joins them with "or", not a comma soup',
  /913-948-3747 or 913-933-1687/.test(back), (back.match(/Or call[^<]*/) || [''])[0]);
check('the offer card still says what to say on the call',
  /say &quot;free site\.&quot;|say "free site\."/.test(back), (back.match(/Or call[^<]*/) || [''])[0]);
check('the delivery card offers to walk them through it instead',
  /walk you through it/.test(deliveredBack), (deliveredBack.match(/Or call[^<]*/) || [''])[0]);

console.log('\nNOTHING THAT ALREADY WORKED WAS TAKEN AWAY');

check('the offer card still leads with the free-website headline', /100% Free/.test(front));
check('the delivery card still leads with "already built"', /already built/.test(delivered));
check('the delivery card still prints where the site is', delivered.includes('killswitchwebsites.com/s/oouwees'));
check('the trade is still pluralised for the audience', /Built for salons and barbershops/.test(back),
  (back.match(/Built for [^<]*/) || [''])[0]);
check('the business name is still on the delivery card', delivered.includes("Oou Wee's Barbershop"));
check('the card is still the right size for Lob', front.includes('9.25in') && front.includes('6.25in'));

// A business name with an ampersand must not break the markup. Note this has to
// be tested on the DELIVERY card: the offer card never prints the name at all,
// so asserting against it proves nothing.
const NASTY = { name: 'Bob & Sons <script>alert(1)</script>', trade: 'plumber', siteUrl: 'killswitchwebsites.com/s/bob' };
const nastyFront = P.frontHtml(NASTY);
const nastyBack = P.backHtml(NASTY);
check('the delivery card really does print the name, so this test is not vacuous',
  nastyFront.includes('Bob') && nastyBack.includes('Bob'));
check('a business name cannot inject markup into the front', !nastyFront.includes('<script>'), nastyFront.slice(0, 120));
check('nor into the back', !nastyBack.includes('<script>'));
check('and its ampersand is escaped on both sides',
  nastyFront.includes('Bob &amp; Sons') && nastyBack.includes('Bob &amp; Sons'));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
