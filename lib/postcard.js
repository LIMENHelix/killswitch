// Server-side postcard HTML for Lob (ported from _outreach/mail.py so the admin
// can send the exact same card). Front + address-safe back, playbook copy.

const PHONE = (process.env.KS_PHONE || '').trim();

const TRADE_PLURAL = {
  'salon/barber': 'salons and barbershops', 'nails/beauty': 'nail and beauty shops',
  dentist: 'dentists', 'clinic/doctor': 'clinics', 'auto repair': 'auto shops',
  'auto body': 'auto shops', restaurant: 'restaurants', 'cafe/coffee': 'cafes',
  vet: 'veterinary clinics', florist: 'florists', bakery: 'bakeries',
  'gym/fitness': 'gyms', plumber: 'plumbers', electrician: 'electricians',
  roofer: 'roofers', painter: 'painters', landscaper: 'landscapers',
  'pet groomer': 'pet groomers', hvac: 'HVAC companies', cleaning: 'cleaning services',
};

export function frontHtml() {
  return `<html><head><meta charset="utf-8"><style>
    @page{margin:0}html,body{margin:0;padding:0;width:9.25in;height:6.25in}
    .card{width:9.25in;height:6.25in;background:#121214;color:#fff;font-family:Arial,Helvetica,sans-serif;box-sizing:border-box;padding:0.8in 0.85in;position:relative}
    .haz{position:absolute;top:0;left:0;right:0;height:0.16in;background:repeating-linear-gradient(-45deg,#FFC42E 0 0.22in,#161616 0.22in 0.44in)}
    h1{font-size:62px;line-height:1.02;margin:0.12in 0 0.14in;font-weight:900;letter-spacing:-1px}
    h1 .f{color:#FFC42E}
    .tag{font-size:25px;font-weight:600;color:#b6bac2;margin:0 0 0.2in}
    .own{font-size:26px;font-weight:800;color:#fff;line-height:1.32;margin:0;max-width:6.6in}
    .own b{color:#FFC42E}
    .brand{position:absolute;bottom:0.62in;left:0.85in;font-size:20px;font-weight:900;letter-spacing:2px}
    .brand .dot{color:#FF3826}
    .ph{position:absolute;bottom:0.55in;right:0.85in;text-align:right}
    .ph .l{font-size:13px;letter-spacing:2px;color:#b6bac2;text-transform:uppercase;margin-bottom:2px}
    .ph .n{font-size:30px;font-weight:900;color:#FFC42E;letter-spacing:-0.5px}
  </style></head><body><div class="card"><div class="haz"></div>
    <h1>Claim your<br><span class="f">100% Free</span> Website</h1>
    <p class="tag">The easiest, fastest, most productive decision you could make with your business to get seen and increase traffic.</p>
    <p class="own">You <b>own it</b>. No contract. Turn on only what you need.</p>
    <div class="brand">KILLSWITCHWEBSITES<span class="dot">.</span>COM</div>
    ${PHONE ? `<div class="ph"><div class="l">Call or text</div><div class="n">${PHONE}</div></div>` : ''}
  </div></body></html>`;
}

export function backHtml(lead) {
  const trade = TRADE_PLURAL[lead.trade] || 'local businesses';
  const phoneLine = PHONE ? `<div class="cta2">Or call or text ${PHONE} and say "free site."</div>` : '';
  return `<html><head><meta charset="utf-8"><style>
    @page{margin:0}html,body{margin:0;padding:0;width:9.25in;height:6.25in}
    .card{width:9.25in;height:6.25in;background:#fff;color:#15161a;font-family:Arial,Helvetica,sans-serif;box-sizing:border-box;padding:0.42in 0.5in}
    .copy{width:5.1in}
    .h{font-size:21px;font-weight:900;margin:0 0 8px;letter-spacing:-.2px}
    .copy p{font-size:14px;line-height:1.4;margin:0 0 6px}
    .catch b{font-weight:800}
    .more{font-size:13px;color:#3a3a3a;line-height:1.38;margin:0 0 6px}
    .built{font-size:15px;font-weight:900;margin:10px 0 7px}
    .cta{font-size:16px;font-weight:900;color:#0a7d3b;margin:0}
    .cta .u{text-decoration:underline}
    .cta2{font-size:13.5px;font-weight:700;color:#15161a;margin:4px 0 0}
  </style></head><body><div class="card"><div class="copy">
    <div class="h">Here's how it works.</div>
    <p>We build you a real website. It's free. It's yours to keep. There's no contract.</p>
    <p class="catch">Later, most shops want more: showing up on Google, online booking, card payments, an AI that answers the phone at 2 a.m. Those run $19 to $29 a month each. <b>You turn on what you want. Nothing else switches on.</b></p>
    <p>That's it. The free website is how we meet you.</p>
    <p class="more">Want something bigger down the road, like an online store or a booking system? We build those too. Just ask.</p>
    <div class="built">Built for ${trade}. We take a few builds a month.</div>
    <div class="cta">&rarr; <span class="u">killswitchwebsites.com</span>, usually same day, no call needed</div>
    ${phoneLine}
  </div></div></body></html>`;
}
