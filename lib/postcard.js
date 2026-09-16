// Server-side postcard HTML for Lob (ported from _outreach/mail.py so the admin
// can send the exact same card). Front + address-safe back.
//
// THE OFFER CARD IS THE K6 CARD. The K6 send pool is the legacy lead queue plus
// K5 drafted prospects, and drafts are NEVER published by any send path — so a
// K6 recipient does not have a live site to point at, and the card must not
// claim one exists. "We already built one for you" appears ONLY on the delivery
// variant, which requires a published siteUrl (a real, reachable page). Every
// claim on the card is true for every recipient of that variant.
//
// No prices, no "catch", no betting language, no feature tour: the site is
// free, optional tools can be added later, and nothing paid starts unless they
// choose it. The QR and the printed URL go to the same working destination
// (killswitch.domains/start -> the intake form). The QR is a committed static
// asset (qr-start.png) served from this site, so Lob's renderer fetches it
// from us — no third-party image service in the print path.
const QR_IMG = 'https://killswitchwebsites.com/qr-start.png';
const START_URL = 'killswitch.domains/start';

// THE NUMBERS THE CARD ACTUALLY CARRIES.
//
// READ KS_PHONES, NOT KS_PHONE. The old variable is set in production to a
// single Google Voice line. Leaving it as the override meant the card would
// keep printing that one number after being told to print two, and Vercel
// blanks sensitive values on `env pull`, so there is no way to read the value
// back and notice. A default that a stale variable silently beats is not a
// default; it is a trap that only shows up on paper a week later.
//
// So the override moved to a NEW name. KS_PHONES is unset, so these two apply,
// and setting it later still changes the numbers without a deploy. Nothing was
// taken away: KS_PHONE can be deleted from Vercel at leisure, and until then it
// is simply ignored.
const PHONES = (process.env.KS_PHONES || '913-948-3747, 913-933-1687')
  .split(',').map((s) => s.trim()).filter(Boolean);

const TRADE_PLURAL = {
  'salon/barber': 'salons and barbershops', 'nails/beauty': 'nail and beauty shops',
  dentist: 'dentists', 'clinic/doctor': 'clinics', 'auto repair': 'auto shops',
  'auto body': 'auto shops', restaurant: 'restaurants', 'cafe/coffee': 'cafes',
  vet: 'veterinary clinics', florist: 'florists', bakery: 'bakeries',
  'gym/fitness': 'gyms', plumber: 'plumbers', electrician: 'electricians',
  roofer: 'roofers', painter: 'painters', landscaper: 'landscapers',
  'pet groomer': 'pet groomers', hvac: 'HVAC companies', cleaning: 'cleaning services',
};

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * @param {object} [lead] when it carries `siteUrl`, the card stops being an offer
 * and becomes a delivery: their site already exists and the card says where.
 * That is a completely different piece of mail, so it gets a different front.
 */
export function frontHtml(lead = {}) {
  const url = String(lead.siteUrl || '').trim();
  const head = url
    ? `<h1>Your website<br>is <span class="f">already built</span>.</h1>
       <p class="tag">We made one for ${esc(String(lead.name || 'your business').slice(0, 46))}. It is live right now, it is free, and it is yours.</p>
       <p class="own">See it: <b>${esc(url)}</b></p>`
    : `<h1>Your business website.<br><span class="f">Free.</span></h1>
       <p class="tag">Yours to keep. No contract. No card required.</p>
       <p class="own">Get it: <b>${START_URL}</b></p>`;
  return `<html><head><meta charset="utf-8"><style>
    @page{margin:0}html,body{margin:0;padding:0;width:9.25in;height:6.25in}
    .card{width:9.25in;height:6.25in;background:#121214;color:#fff;font-family:Arial,Helvetica,sans-serif;box-sizing:border-box;padding:0.8in 0.85in;position:relative}
    .haz{position:absolute;top:0;left:0;right:0;height:0.16in;background:repeating-linear-gradient(-45deg,#FFC42E 0 0.22in,#161616 0.22in 0.44in)}
    h1{font-size:${url ? 56 : 58}px;line-height:1.02;margin:0.12in 0 0.14in;font-weight:900;letter-spacing:-1px}
    h1 .f{color:#FFC42E}
    .tag{font-size:${url ? 23 : 25}px;font-weight:600;color:#b6bac2;margin:0 0 0.2in;max-width:7in}
    .own{font-size:26px;font-weight:800;color:#fff;line-height:1.32;margin:0;max-width:7in;word-break:break-all}
    .own b{color:#FFC42E}
    .brand{position:absolute;bottom:0.62in;left:0.85in;font-size:20px;font-weight:900;letter-spacing:2px}
    .brand .dot{color:#FF3826}
    .ph{position:absolute;bottom:0.55in;right:0.85in;text-align:right}
    .ph .l{font-size:13px;letter-spacing:2px;color:#b6bac2;text-transform:uppercase;margin-bottom:2px}
    .ph .n{font-size:${PHONES.length > 1 ? 25 : 30}px;font-weight:900;color:#FFC42E;letter-spacing:-0.5px;line-height:1.16}
  </style></head><body><div class="card"><div class="haz"></div>
    ${head}
    <div class="brand">KILLSWITCHWEBSITES<span class="dot">.</span>COM</div>
    ${PHONES.length ? `<div class="ph"><div class="l">Call or text</div>${PHONES.map((p) => `<div class="n">${esc(p)}</div>`).join('')}</div>` : ''}
  </div></body></html>`;
}

export function backHtml(lead) {
  const trade = TRADE_PLURAL[lead.trade] || 'local businesses';
  const url = String(lead.siteUrl || '').trim();
  const phoneLine = PHONES.length
    ? `<div class="cta2">Or call ${PHONES.map(esc).join(' or ')}${url ? ' and we will walk you through it.' : ' and say "free site."'}</div>`
    : '';
  // Two different pieces of mail. One asks them to come and get a website. The
  // other tells them theirs is already sitting at an address — and that claim
  // is only printed when a live URL actually exists.
  const opening = url
    ? `<div class="h">It is already built. Go look.</div>
       <p>We built ${esc(String(lead.name || 'your business').slice(0, 46))} a real website and put it online. Nothing is owed, nothing is signed, and you can have it taken down with one phone call.</p>`
    : `<div class="h">Here's how it works.</div>
       <p>The website is free and yours to keep.</p>`;
  const optional = `<p>If you ever want optional tools like booking, payments, or ongoing updates, you can add them later. <b>Nothing paid starts unless you choose it.</b></p>`;
  const closing = url
    ? `<div class="cta">&rarr; <span class="u">${esc(url)}</span></div>`
    : `<div class="cta">Scan the code or visit <span class="u">${START_URL}</span></div>`;
  // The QR goes only on the offer card: it points at the intake page, which is
  // the right destination when no site exists yet. On a delivery card the
  // destination is their own site URL, printed above.
  const qr = url ? '' : `<div class="qr"><img src="${QR_IMG}" alt="QR code for ${START_URL}"><div class="qrcap">Scan to get your website</div></div>`;
  return `<html><head><meta charset="utf-8"><style>
    @page{margin:0}html,body{margin:0;padding:0;width:9.25in;height:6.25in}
    .card{width:9.25in;height:6.25in;background:#fff;color:#15161a;font-family:Arial,Helvetica,sans-serif;box-sizing:border-box;padding:0.42in 0.5in;position:relative}
    .copy{width:5.1in}
    .h{font-size:21px;font-weight:900;margin:0 0 8px;letter-spacing:-.2px}
    .copy p{font-size:14px;line-height:1.4;margin:0 0 6px}
    .built{font-size:15px;font-weight:900;margin:10px 0 7px}
    .cta{font-size:16px;font-weight:900;color:#0a7d3b;margin:0}
    .cta .u{text-decoration:underline}
    .cta2{font-size:13.5px;font-weight:700;color:#15161a;margin:4px 0 0}
    .qr{position:absolute;top:0.75in;right:0.55in;width:2.1in;text-align:center}
    .qr img{width:2.1in;height:2.1in;display:block}
    .qrcap{font-size:12.5px;font-weight:800;margin-top:6px}
  </style></head><body><div class="card"><div class="copy">
    ${opening}
    ${optional}
    <div class="built">Built for ${trade}.</div>
    ${closing}
    ${phoneLine}
  </div>${qr}</div></body></html>`;
}
