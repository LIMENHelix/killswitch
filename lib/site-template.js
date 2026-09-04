// THE template. One function renders every customer site. Sections appear only
// when the matching module is switched on, so turning P3 off in the panel makes
// the booking block vanish from the live site with no rebuild and no deploy.
//
// Killswitch's own site is a record in here too, with everything on, so the
// demo and the product are literally the same code path. If a section is broken
// for a customer it is broken for us first.

import { has } from './sites.js';

const e = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const telHref = (p) => 'tel:+1' + String(p || '').replace(/\D/g, '');

// FIVE LOOKS, ONE TEMPLATE.
//
// Everything that makes a customer site look like itself is these nine colours
// and two fonts. `warm` is the original palette character for character, so a
// site that has never picked a theme renders exactly what it rendered before.
// That is deliberate: adding choice must not restyle anybody's live website.
//
// A THEME IS FREE. There is no phase code here and nothing in lib/prices.js.
// Picking a look is not an upsell, it is the thing that makes a free site feel
// like theirs, and a customer who feels ownership is the one who later buys a
// switch. Do not put this behind a module.
export const FACTORY_ACCENT = '#12703C';

export const THEMES = {
  warm: {
    label: 'Warm', note: 'Cream and deep green. The original.',
    ac: FACTORY_ACCENT, bg: '#F6F1E7', pn: '#fff', ink: '#1E1B16', mut: '#5A5347', ln: '#D8CFBC',
    nav: 'rgba(246,241,231,.9)', alt: '#FBF8F2', fld: '#fff',
    fh: '"Manrope",sans-serif', fb: '"Inter",system-ui,sans-serif',
    fonts: 'family=Manrope:wght@600;700;800&family=Inter:wght@400;500;600&display=swap',
  },
  clean: {
    label: 'Clean', note: 'White and blue. Plain and modern.',
    ac: '#1D4ED8', bg: '#FFFFFF', pn: '#F7F8FA', ink: '#14171A', mut: '#5B6470', ln: '#E2E6EB',
    nav: 'rgba(255,255,255,.9)', alt: '#FFFFFF', fld: '#FFFFFF',
    fh: '"Inter",system-ui,sans-serif', fb: '"Inter",system-ui,sans-serif',
    fonts: 'family=Inter:wght@400;500;600;700;800&display=swap',
  },
  midnight: {
    label: 'Midnight', note: 'Dark background, bright accent.',
    ac: '#38BDF8', bg: '#14171C', pn: '#1C2027', ink: '#EEF1F5', mut: '#9AA4B2', ln: '#2C333D',
    nav: 'rgba(20,23,28,.9)', alt: '#232932', fld: '#1C2027',
    fh: '"Space Grotesk",sans-serif', fb: '"Inter",system-ui,sans-serif',
    fonts: 'family=Space+Grotesk:wght@600;700&family=Inter:wght@400;500;600&display=swap',
  },
  bold: {
    label: 'Bold', note: 'Heavy type and red. Built for trades.',
    ac: '#DC2626', bg: '#FFFFFF', pn: '#F4F4F5', ink: '#0A0A0A', mut: '#52525B', ln: '#D4D4D8',
    nav: 'rgba(255,255,255,.92)', alt: '#FAFAFA', fld: '#FFFFFF',
    fh: '"Archivo",sans-serif', fb: '"Inter",system-ui,sans-serif',
    fonts: 'family=Archivo:wght@700;800&family=Inter:wght@400;500;600&display=swap',
  },
  coastal: {
    label: 'Coastal', note: 'Cool grey and teal. Calm and clinical.',
    ac: '#0F766E', bg: '#F5F7FA', pn: '#FFFFFF', ink: '#0F172A', mut: '#475569', ln: '#DCE3EC',
    nav: 'rgba(245,247,250,.9)', alt: '#F8FAFC', fld: '#FFFFFF',
    fh: '"Sora",sans-serif', fb: '"Inter",system-ui,sans-serif',
    fonts: 'family=Sora:wght@600;700&family=Inter:wght@400;500;600&display=swap',
  },
};

export const DEFAULT_THEME = 'warm';
/** The names a customer may choose, in the order they should be offered. */
export const THEME_NAMES = Object.keys(THEMES);

/** Is this a theme we actually ship? The endpoint refuses anything else. */
export function isTheme(name) {
  return Object.prototype.hasOwnProperty.call(THEMES, String(name == null ? '' : name).toLowerCase());
}

/** The theme record, falling back to the original look for '' and for junk. */
export function themeFor(name) {
  return THEMES[String(name == null ? '' : name).toLowerCase()] || THEMES[DEFAULT_THEME];
}

/**
 * Readable text ON the accent colour.
 *
 * Every button, the assistant bubble and the chat launcher used to hardcode
 * white text on the accent. That is correct for a dark green and unreadable on
 * a yellow, so the moment anyone can choose a colour it becomes a real defect.
 *
 * MEASURE, DO NOT GUESS A THRESHOLD. The first version of this cut over at a
 * luminance of 0.45 and Midnight's #38BDF8 lands at 0.4401, so it kept white
 * text at a contrast of 2.14:1, under even the 3.0 that WCAG asks of a button.
 * A threshold is a guess about where the eye gives up. Computing the actual
 * contrast ratio both ways and keeping the higher one is not a guess, it is
 * always the better of the two available answers, and it has no edge to fall
 * off. #12703C keeps white (6.16:1 against 3.07:1), so nothing that exists
 * today changes.
 */
export function onAccent(hex) {
  const h = String(hex == null ? '' : hex).replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return '#fff';
  const lin = (v) => {
    const c = parseInt(v, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const L = 0.2126 * lin(h.slice(0, 2)) + 0.7152 * lin(h.slice(2, 4)) + 0.0722 * lin(h.slice(4, 6));
  const DARK = 0.005605; // relative luminance of #111111
  const onWhite = 1.05 / (L + 0.05);          // contrast of white text on it
  const onDark = (L + 0.05) / (DARK + 0.05);  // contrast of near-black text on it
  return onDark > onWhite ? '#111111' : '#fff';
}


// TWO AXES, NOT ONE. `theme` is the COLOUR (five palettes above). `layout` is
// the SHAPE, and it is a different question: a drafting firm and a plumber can
// want the same colours and completely different pages.
//
// '' IS THE LAYOUT EVERY EXISTING SITE ALREADY HAS. It dispatches to the
// original renderer below, untouched, so shipping a new layout changes nobody's
// live page until they choose one. Same contract as theme:'' meaning warm.
export const LAYOUTS = {
  classic: { label: 'Classic', note: 'Simple and quiet. The original.' },
  trade: { label: 'Trade', note: 'Bold and full-bleed. Built to be seen on a phone at a job site.' },
};
export const DEFAULT_LAYOUT = 'classic';
export const LAYOUT_NAMES = Object.keys(LAYOUTS);

export function isLayout(name) {
  return Object.prototype.hasOwnProperty.call(LAYOUTS, String(name == null ? '' : name).toLowerCase());
}
export function layoutFor(name) {
  const n = String(name == null ? '' : name).toLowerCase();
  return isLayout(n) ? n : DEFAULT_LAYOUT;
}

export function renderSite(site, opts = {}) {
  // Dispatch BEFORE anything else, so the classic path is the code it always
  // was rather than the code it was plus an if.
  if (layoutFor(site && site.layout) === 'trade') return renderTrade(site, opts);
  return renderClassic(site, opts);
}

function renderClassic(site, opts = {}) {
  const s = site;
  const theme = themeFor(s.theme);
  // A COLOUR SOMEBODY CHOSE BEATS THE THEME'S. A colour still sitting at the
  // factory default does not, or picking Midnight would leave the buttons the
  // original green and the theme would look half applied. SITE_DEFAULT stamps
  // accent onto every record, so "never set" is not distinguishable any other way.
  const chosen = /^#[0-9a-fA-F]{6}$/.test(s.accent || '') ? s.accent : '';
  const accent = (chosen && chosen.toLowerCase() !== FACTORY_ACCENT.toLowerCase()) ? chosen : theme.ac;
  const addr = [s.street, [s.city, s.state].filter(Boolean).join(', '), s.zip].filter(Boolean).join(' · ');
  const title = `${s.business}${s.city ? ' · ' + s.city : ''}${s.state ? ', ' + s.state : ''}`;
  const desc = s.tagline || `${s.business}${s.trade ? ', ' + s.trade : ''}${s.city ? ' in ' + s.city : ''}.`;
  const base = opts.base || 'https://killswitchwebsites.com';
  const canonical = `${base}/s/${e(s.slug)}`;

  // P1 turns on the rich local-business listing markup search engines read.
  const schema = has(s, 'P1') ? `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'LocalBusiness',
    name: s.business, description: desc, url: canonical,
    telephone: s.phone || undefined,
    address: (s.street || s.city) ? {
      '@type': 'PostalAddress', streetAddress: s.street || undefined,
      addressLocality: s.city || undefined, addressRegion: s.state || undefined, postalCode: s.zip || undefined,
    } : undefined,
  })}</script>` : '';

  const nav = [
    s.services.length ? '<a href="#services">Services</a>' : '',
    has(s, 'P2') && s.posts.length ? '<a href="#updates">Updates</a>' : '',
    has(s, 'P3') ? '<a href="#book">Book</a>' : '',
    has(s, 'P7') ? '<a href="#pay">Pay</a>' : '',
    '<a href="#contact">Contact</a>',
  ].filter(Boolean).join('');

  const heroCta = [
    has(s, 'P3') ? '<a class="btn" href="#book">Book online</a>' : '',
    s.phone ? `<a class="btn ghost" href="${telHref(s.phone)}">Call ${e(s.phone)}</a>` : '',
  ].filter(Boolean).join('');

  const services = s.services.length ? `
  <section id="services" class="sec">
    <h2>What we do</h2>
    <div class="grid">
      ${s.services.map((x) => `<div class="card"><h3>${e(x.name)}</h3>${x.desc ? `<p>${e(x.desc)}</p>` : ''}</div>`).join('')}
    </div>
  </section>` : '';

  const about = s.about ? `<section class="sec narrow"><h2>About ${e(s.business)}</h2><p class="lead">${e(s.about)}</p></section>` : '';

  // ---- P3 Online booking ----
  const booking = has(s, 'P3') ? `
  <section id="book" class="sec alt">
    <h2>Book online</h2>
    <p class="lead">Pick a time that suits you. You will get a confirmation straight away.</p>
    ${s.bookingUrl
      ? `<div class="embed"><iframe src="${e(s.bookingUrl)}" title="Booking" loading="lazy"></iframe></div>`
      : `<form class="bk" onsubmit="return ksBook(event)">
           <input name="name" placeholder="Your name" required />
           <input name="phone" placeholder="Your phone" required />
           <input name="when" placeholder="Day and time that suits you" required />
           <button class="btn" type="submit">Request this time</button>
           <p class="fine" id="bkMsg"></p>
         </form>`}
  </section>` : '';

  // ---- P7 Pay online ----
  const pay = has(s, 'P7') ? `
  <section id="pay" class="sec">
    <h2>Pay online</h2>
    <p class="lead">Settle your invoice by card, any time.</p>
    ${s.payUrl
      ? `<a class="btn" href="${e(s.payUrl)}" target="_blank" rel="noopener">Pay your invoice</a>`
      : `<p class="fine">Card payments are switched on. Your payment link appears here once it is connected.</p>`}
  </section>` : '';

  // ---- P2 Updates ----
  const updates = has(s, 'P2') && s.posts.length ? `
  <section id="updates" class="sec alt">
    <h2>Latest from ${e(s.business)}</h2>
    <div class="grid">
      ${s.posts.slice(0, 3).map((p) => `<div class="card">${p.date ? `<div class="dt">${e(p.date)}</div>` : ''}<h3>${e(p.title)}</h3>${p.body ? `<p>${e(p.body)}</p>` : ''}</div>`).join('')}
    </div>
  </section>` : '';

  const hours = s.hours.length
    ? `<div class="hrs">${s.hours.map((h) => `<div><span>${e(h.d)}</span><b>${e(h.h)}</b></div>`).join('')}</div>` : '';

  // ---- Contact form: FREE, on every site ----
  // The pricing page has always listed "Contact form" under the $0 tier, and the
  // template had none. The only two forms here were booking (P3, $19/mo) and the
  // AI assistant (P9, $29/mo), so a free customer's finished site gave a visitor
  // no way to reach them except tapping a phone number. That is the bullet made
  // true, and it is the single most useful thing a small site can do.
  const contactForm = `
    <form class="cf" onsubmit="return ksContact(event)">
      <h3>Send a message</h3>
      <input name="name" placeholder="Your name" required maxlength="80" />
      <input name="contact" placeholder="Phone or email" required maxlength="120" />
      <textarea name="message" placeholder="How can we help?" required maxlength="1200" rows="4"></textarea>
      <div class="hp" aria-hidden="true"><input name="website" tabindex="-1" autocomplete="off" /></div>
      <button class="btn" type="submit">Send</button>
      <p class="fine" id="cfMsg"></p>
    </form>`;

  // ---- P9 AI assistant ----
  const ai = has(s, 'P9') ? `
  <button class="aibtn" id="aiBtn" type="button" aria-label="Ask a question">Ask a question</button>
  <div class="aip" id="aiP">
    <div class="aih"><b>Ask ${e(s.business)}</b><button type="button" id="aiX" aria-label="Close">&times;</button></div>
    <div class="aim" id="aiM"><div class="b">Hi. Ask me anything about our services, hours or prices.</div></div>
    <form class="aif" onsubmit="return ksAsk(event)"><input id="aiI" placeholder="Type your question" autocomplete="off" /><button class="btn sm" type="submit">Send</button></form>
  </div>` : '';

  // ---- P8 Analytics ----
  // A beacon, not a page-serve counter: /api/site serves this page behind a 60s
  // edge cache, so counting there would miss every cached view and undercount a
  // paying customer's traffic. keepalive so it still sends if they navigate away
  // immediately. It fires only when P8 is on, so the cost follows the revenue.
  const analytics = has(s, 'P8')
    ? `<script>try{fetch('/api/site-action',{method:'POST',keepalive:true,headers:{'content-type':'application/json'},body:JSON.stringify({action:'view',slug:${JSON.stringify(s.slug)}})})}catch(e){}</script>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${e(title)}</title>
<meta name="description" content="${e(desc)}" />
${s.claimed ? '' : '<meta name="robots" content="noindex, nofollow" />\n'}<link rel="canonical" href="${canonical}" />
<meta property="og:title" content="${e(title)}" /><meta property="og:description" content="${e(desc)}" />
<meta property="og:type" content="website" /><meta property="og:url" content="${canonical}" />
${schema}
<link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?${theme.fonts}" rel="stylesheet" />
<style>
 :root{--ac:${accent};--bg:${theme.bg};--pn:${theme.pn};--ink:${theme.ink};--mut:${theme.mut};--ln:${theme.ln};--nav:${theme.nav};--alt:${theme.alt};--fld:${theme.fld};--on:${onAccent(accent)};--fh:${theme.fh};--fb:${theme.fb}}
 *{box-sizing:border-box;margin:0;padding:0}
 /* This template renders whatever a real business is called and however long
    their email is, so nothing here can assume a word fits. A single long token,
    servicedesk@gonzalezandsonsautomotive.com say, used to push the contact block
    63px past the screen on a phone. */
 body{background:var(--bg);color:var(--ink);font-family:var(--fb);line-height:1.6;overflow-wrap:break-word}
 a{color:inherit;text-decoration:none}
 h1,h2,h3{font-family:var(--fh);letter-spacing:-.02em;line-height:1.15}
 .wrap{max-width:1060px;margin:0 auto;padding:0 22px}
 nav{position:sticky;top:0;z-index:40;background:var(--nav);backdrop-filter:blur(8px);border-bottom:1px solid var(--ln)}
 .nv{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:15px 0;flex-wrap:wrap}
 .bn{font-family:var(--fh);font-weight:800;font-size:1.1rem}
 .nl{display:flex;gap:20px;flex-wrap:wrap}.nl a{color:var(--mut);font-size:.92rem}.nl a:hover{color:var(--ink)}
 .hero{padding:64px 0 52px}
 .hero h1{font-size:clamp(2rem,5vw,3.2rem);font-weight:800}
 .hero .tg{margin-top:14px;font-size:1.15rem;color:var(--mut);max-width:32em}
 .cta{margin-top:26px;display:flex;gap:12px;flex-wrap:wrap}
 .btn{display:inline-block;background:var(--ac);color:var(--on);border:1px solid var(--ac);border-radius:11px;padding:13px 22px;font-weight:600;cursor:pointer;font-size:1rem;font-family:inherit}
 .btn:hover{filter:brightness(1.08)} .btn.sm{padding:9px 14px;font-size:.88rem}
 .btn.ghost{background:transparent;color:var(--ink);border-color:var(--ln)}
 .sec{padding:52px 0;border-top:1px solid var(--ln)}
 .sec.alt{background:var(--pn)} .sec.narrow p{max-width:60ch}
 .sec h2{font-size:1.7rem;font-weight:800;margin-bottom:8px}
 .lead{color:var(--mut);margin-bottom:22px;max-width:60ch}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:16px}
 .grid>*{min-width:0}
 .card{background:var(--bg);border:1px solid var(--ln);border-radius:14px;padding:20px}
 .sec.alt .card{background:var(--alt)}
 .card h3{font-size:1.05rem;font-weight:700;margin-bottom:5px} .card p{color:var(--mut);font-size:.94rem}
 .card .dt{font-size:.74rem;color:var(--mut);text-transform:uppercase;letter-spacing:.08em;margin-bottom:5px}
 .hrs{display:grid;gap:7px;max-width:340px;margin-top:6px}
 .hrs div{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid var(--ln);padding-bottom:6px;font-size:.95rem}
 .hrs span{color:var(--mut)}
 .bk{display:grid;gap:11px;max-width:420px}
 .bk input{padding:13px 15px;border:1px solid var(--ln);border-radius:11px;background:var(--fld);font:inherit;font-size:1rem;color:var(--ink)}
 .bk input:focus{outline:none;border-color:var(--ac)}
 .cf{display:grid;gap:11px;max-width:460px}
 .cf h3{font-size:1.05rem;font-weight:700}
 .cf input,.cf textarea{padding:13px 15px;border:1px solid var(--ln);border-radius:11px;background:var(--fld);font:inherit;font-size:1rem;color:var(--ink);width:100%}
 .cf textarea{resize:vertical;min-height:96px}
 .cf input:focus,.cf textarea:focus{outline:none;border-color:var(--ac)}
 .cf .btn{justify-self:start}
 /* Honeypot. The old left:-9999px trick creates a real 10,000px-wide box off to
    the side, which an overflow audit flags and which can push a page sideways in
    some layouts. clip-path keeps it in the flow at zero size instead. */
 .hp{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
 .fine{font-size:.88rem;color:var(--mut)}
 .embed iframe{width:100%;height:640px;border:1px solid var(--ln);border-radius:14px;background:var(--fld)}
 /* min() so the column can drop below 240px on a narrow phone instead of forcing
    the grid wider than the screen, and min-width:0 because a grid item defaults
    to min-width:auto, which refuses to shrink below its longest word. */
 .cts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:26px}
 .cts>div{min-width:0}
 .cts a{overflow-wrap:anywhere}
 .cts a.big{font-size:1.25rem;font-weight:700;color:var(--ac)}
 footer{border-top:1px solid var(--ln);padding:26px 0 34px;color:var(--mut);font-size:.86rem}
 footer a{border-bottom:1px solid var(--ln)}
 .aibtn{position:fixed;right:18px;bottom:18px;z-index:50;background:var(--ac);color:var(--on);border:0;border-radius:999px;padding:14px 20px;font:inherit;font-weight:600;cursor:pointer;box-shadow:0 10px 30px -10px rgba(0,0,0,.4)}
 .aip{position:fixed;right:18px;bottom:18px;z-index:51;width:min(370px,calc(100vw - 36px));background:var(--fld);border:1px solid var(--ln);border-radius:16px;display:none;overflow:hidden;box-shadow:0 24px 60px -20px rgba(0,0,0,.35)}
 .aip.open{display:block}
 .aih{display:flex;justify-content:space-between;align-items:center;padding:13px 16px;border-bottom:1px solid var(--ln)}
 .aih button{background:none;border:0;font-size:1.3rem;cursor:pointer;color:var(--mut)}
 .aim{padding:14px 16px;max-height:320px;overflow:auto;display:flex;flex-direction:column;gap:9px}
 .aim .b,.aim .u{padding:10px 13px;border-radius:12px;font-size:.93rem;max-width:88%}
 .aim .b{background:var(--bg);align-self:flex-start} .aim .u{background:var(--ac);color:var(--on);align-self:flex-end}
 .aif{display:flex;gap:8px;padding:12px 14px;border-top:1px solid var(--ln)}
 .aif input{flex:1;padding:10px 13px;border:1px solid var(--ln);border-radius:10px;font:inherit}
 .aif input:focus{outline:none;border-color:var(--ac)}
 @media(max-width:560px){.nl{gap:14px}.nl a{font-size:.85rem}}
</style>
</head>
<body>
<nav><div class="wrap nv"><a href="#" class="bn">${e(s.business)}</a><div class="nl">${nav}</div></div></nav>

<header class="hero"><div class="wrap">
  <h1>${e(s.business)}</h1>
  ${s.tagline ? `<p class="tg">${e(s.tagline)}</p>` : ''}
  ${heroCta ? `<div class="cta">${heroCta}</div>` : ''}
</div></header>

<div class="wrap">${services}${updates}${booking}${pay}${about}</div>

<section id="contact" class="sec alt"><div class="wrap">
  <h2>Find us</h2>
  <div class="cts">
    <div>
      ${s.phone ? `<a class="big" href="${telHref(s.phone)}">${e(s.phone)}</a><br>` : ''}
      ${s.email_public ? `<a href="mailto:${e(s.email_public)}">${e(s.email_public)}</a><br>` : ''}
      ${addr ? `<p style="color:var(--mut);margin-top:8px">${e(addr)}</p>` : ''}
      ${hours ? `<div style="margin-top:18px"><b>Opening hours</b>${hours}</div>` : ''}
    </div>
    ${contactForm}
  </div>
</div></section>

<footer><div class="wrap">
  &copy; ${new Date().getFullYear()} ${e(s.business)}.
  <span style="opacity:.75">Site by <a href="${base}" target="_blank" rel="noopener">Killswitch Websites</a></span>
</div></footer>

${ai}
<script>
var KS_SLUG=${JSON.stringify(s.slug)};
function ksBook(ev){ev.preventDefault();var f=ev.target,m=document.getElementById('bkMsg');
 m.textContent='Sending…';
 fetch('/api/site-action',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({action:'book',slug:KS_SLUG,name:f.name.value,phone:f.phone.value,when:f.when.value})})
 .then(function(r){return r.json()}).then(function(d){
   m.textContent=d&&d.ok?'Thanks. We have your request and will confirm shortly.':'That did not send. Please call us instead.';
   if(d&&d.ok)f.reset();}).catch(function(){m.textContent='That did not send. Please call us instead.';});
 return false;}
function ksContact(ev){ev.preventDefault();var f=ev.target,m=document.getElementById('cfMsg');
 m.textContent='Sending…';
 fetch('/api/site-action',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({action:'contact',slug:KS_SLUG,name:f.name.value,contact:f.contact.value,message:f.message.value,website:f.website.value})})
 .then(function(r){return r.json()}).then(function(d){
   m.textContent=d&&d.ok?'Thanks. Your message is on its way, we will get back to you shortly.':'That did not send. Please call us instead.';
   if(d&&d.ok)f.reset();}).catch(function(){m.textContent='That did not send. Please call us instead.';});
 return false;}
${has(s, 'P9') ? `
var aiH=[];
document.getElementById('aiBtn').onclick=function(){document.getElementById('aiP').classList.add('open');this.style.display='none';};
document.getElementById('aiX').onclick=function(){document.getElementById('aiP').classList.remove('open');document.getElementById('aiBtn').style.display='block';};
function ksAsk(ev){ev.preventDefault();var i=document.getElementById('aiI'),m=document.getElementById('aiM'),q=i.value.trim();
 if(!q)return false;i.value='';
 var u=document.createElement('div');u.className='u';u.textContent=q;m.appendChild(u);
 var b=document.createElement('div');b.className='b';b.textContent='…';m.appendChild(b);m.scrollTop=m.scrollHeight;
 aiH.push({role:'user',content:q});
 fetch('/api/site-action',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({action:'ask',slug:KS_SLUG,messages:aiH.slice(-8)})})
 .then(function(r){return r.json()}).then(function(d){
   b.textContent=(d&&d.reply)||'Sorry, I could not answer that. Please call us.';
   aiH.push({role:'assistant',content:b.textContent});m.scrollTop=m.scrollHeight;})
 .catch(function(){b.textContent='Sorry, I could not answer that. Please call us.';});
 return false;}` : ''}
</script>
${analytics}
</body>
</html>`;
}

/**
 * THE TRADE LAYOUT. The demo's treatment, driven only by the record.
 *
 * Ported from demos/auto-tech-shawnee.html, which is a hand-built static file
 * that has never gone through this template. That divergence is the whole
 * problem this fixes: the page shown to prospects and the page a customer
 * received were two different code paths, and only one of them was any good.
 *
 * WHAT PORTS: the treatment. Sticky bar with a call button, a logo mark, a
 * full-bleed hero with layered depth, uppercase eyebrows, icon-tile service
 * cards, section rhythm, a real footer.
 *
 * WHAT DOES NOT PORT: the demo's FACTS. "4.7 stars", "70+ Google reviews",
 * "NAPA AutoCare", the Shawnee address and phone are things somebody wrote
 * about one business. We hold none of them for anyone else, so the rating
 * badge and the stat band are driven by the record and vanish when it is
 * silent. lib/draft-site.js sets the rule this follows: a website that invents
 * something about a business is worse than no website, because the owner reads
 * it back to you on the delivery call.
 *
 * BUILT ON THE THEME VARIABLES, not on the demo's dark palette, so all five
 * colours work. The demo is dark; Warm, Clean, Bold and Coastal are light, and
 * a hero glow tuned for one is invisible or garish on the other. Everything
 * tints from --ac and --ink via colour-mix, which degrades to the flat colour
 * on a browser that lacks it.
 */
function renderTrade(site, opts = {}) {
  const s = site;
  const theme = themeFor(s.theme);
  const chosen = /^#[0-9a-fA-F]{6}$/.test(s.accent || '') ? s.accent : '';
  const accent = (chosen && chosen.toLowerCase() !== FACTORY_ACCENT.toLowerCase()) ? chosen : theme.ac;
  const on = onAccent(accent);

  const cityState = [s.city, s.state].filter(Boolean).join(', ');
  const addr = [s.street, cityState, s.zip].filter(Boolean).join(', ');
  const title = `${s.business}${s.city ? ' · ' + s.city : ''}${s.state ? ', ' + s.state : ''}`;
  const desc = s.tagline || `${s.business}${s.trade ? ', ' + s.trade : ''}${s.city ? ' in ' + s.city : ''}.`;
  const base = opts.base || 'https://killswitchwebsites.com';
  const canonical = `${base}/s/${e(s.slug)}`;

  // INITIALS, not a logo. Derived from the name they typed, so it invents
  // nothing, and it gives the header the anchor the demo gets from its mark.
  const initials = String(s.business || '')
    .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '·';

  // ESCAPE '<' INSIDE JSON-LD. JSON.stringify does not, so a business name
  // containing '</script>' closes this block and everything after it is parsed
  // as HTML. Business names come straight off the public signup form, and
  // /s/<slug> shares an origin with /panel, so that is script injection on our
  // own domain rather than a cosmetic bug. < is still valid JSON and still
  // reads as '<' to any consumer.
  const ld = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
  const schema = has(s, 'P1') ? `<script type="application/ld+json">${ld({
    '@context': 'https://schema.org', '@type': 'LocalBusiness',
    name: s.business, description: desc, url: canonical,
    telephone: s.phone || undefined,
    address: (s.street || s.city) ? {
      '@type': 'PostalAddress', streetAddress: s.street || undefined,
      addressLocality: s.city || undefined, addressRegion: s.state || undefined, postalCode: s.zip || undefined,
    } : undefined,
  })}</script>` : '';

  const nav = [
    s.services.length ? '<a href="#services">Services</a>' : '',
    has(s, 'P2') && s.posts.length ? '<a href="#updates">Updates</a>' : '',
    has(s, 'P3') ? '<a href="#book">Book</a>' : '',
    has(s, 'P7') ? '<a href="#pay">Pay</a>' : '',
    '<a href="#contact">Contact</a>',
  ].filter(Boolean).join('');

  // The demo's hero has a rating pill and a certification pill. Both are facts.
  // The only badge we can ever stand behind is what they told us they do and
  // where, so that is the only one that renders.
  const badges = [
    s.trade ? `<span class="pill">${e(s.trade)}</span>` : '',
    cityState ? `<span class="pill">${e(cityState)}</span>` : '',
  ].filter(Boolean).join('');

  // The demo's headline is written copy ("Your car, fixed right the first
  // time."). Nobody wrote one for this business, so the headline is their name
  // and the sub is their own tagline. Making one up is the exact failure this
  // file exists to avoid.
  const heroCta = [
    has(s, 'P3') ? `<a class="btn" href="#book">Book online<small>Pick a time that suits you</small></a>` : '',
    s.phone ? `<a class="btn${has(s, 'P3') ? ' ghost' : ''}" href="${telHref(s.phone)}">Call ${e(s.phone)}<small>Talk to us now</small></a>` : '',
  ].filter(Boolean).join('');

  const svcIcon = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const services = s.services.length ? `
  <section class="sec" id="services"><div class="wrap">
    <div class="sec-head"><div class="eyebrow">Services</div><h2>What we do</h2></div>
    <div class="grid">
      ${s.services.map((x) => `<div class="card"><span class="ic">${svcIcon}</span><h3>${e(x.name)}</h3>${x.desc ? `<p>${e(x.desc)}</p>` : ''}</div>`).join('')}
    </div>
  </div></section>` : '';

  // The stat band is where the demo puts "4.7 stars" and "70+ reviews". We hold
  // no numbers about anybody, so it carries only things the record actually
  // knows. With a sparse record every entry is empty and the whole band is
  // dropped rather than shown with blanks in it.
  const stats = [
    s.services.length ? { n: String(s.services.length), l: 'Services offered' } : null,
    cityState ? { n: cityState, l: 'Where we work' } : null,
    s.hours.length ? { n: s.hours[0].h, l: s.hours[0].d } : null,
  ].filter(Boolean);
  const band = stats.length >= 2 ? `
  <div class="band"><div class="wrap">
    ${stats.map((x) => `<div class="stat"><div class="n">${e(x.n)}</div><div class="l">${e(x.l)}</div></div>`).join('')}
  </div></div>` : '';

  const about = s.about ? `
  <section class="sec alt" id="about"><div class="wrap narrow">
    <div class="eyebrow">About</div><h2>About ${e(s.business)}</h2><p class="lead">${e(s.about)}</p>
  </div></section>` : '';

  const updates = has(s, 'P2') && s.posts.length ? `
  <section class="sec" id="updates"><div class="wrap">
    <div class="sec-head"><div class="eyebrow">Updates</div><h2>Latest from ${e(s.business)}</h2></div>
    <div class="grid">
      ${s.posts.map((p) => `<div class="card">${p.date ? `<div class="dt">${e(p.date)}</div>` : ''}<h3>${e(p.title)}</h3>${p.body ? `<p>${e(p.body)}</p>` : ''}</div>`).join('')}
    </div>
  </div></section>` : '';

  const booking = has(s, 'P3') ? `
  <section class="sec alt" id="book"><div class="wrap">
    <div class="sec-head"><div class="eyebrow">Booking</div><h2>Book online</h2>
      <p class="lead">Pick a time that suits you. You will get a confirmation straight away.</p></div>
    ${s.bookingUrl
      ? `<div class="embed"><iframe src="${e(s.bookingUrl)}" title="Booking" loading="lazy"></iframe></div>`
      : `<form class="bk" onsubmit="return ksBook(event)"><input name="name" placeholder="Your name" required /><input name="contact" placeholder="Phone or email" required /><input name="when" placeholder="Day and time that suits you" required /><button class="btn" type="submit">Request a time</button><p class="fine" id="bkMsg"></p></form>`}
  </div></section>` : '';

  const pay = has(s, 'P7') ? `
  <section class="sec" id="pay"><div class="wrap narrow">
    <div class="eyebrow">Payments</div><h2>Pay online</h2>
    <p class="lead">Settle your invoice by card, any time.</p>
    ${s.payUrl ? `<p><a class="btn" href="${e(s.payUrl)}" target="_blank" rel="noopener">Pay your invoice</a></p>`
      : '<p class="fine">Payment link coming shortly.</p>'}
  </div></section>` : '';

  const hours = s.hours.length ? `<div class="info"><div class="eyebrow">Opening hours</div><div class="hrs">${
    s.hours.map((h) => `<div><b>${e(h.d)}</b><span>${e(h.h)}</span></div>`).join('')}</div></div>` : '';

  const ai = has(s, 'P9') ? `
  <button class="aibtn" id="aiBtn" type="button" aria-label="Ask a question">Ask a question</button>
  <div class="aip" id="aiP">
    <div class="aih"><b>Ask ${e(s.business)}</b><button type="button" id="aiX" aria-label="Close">&times;</button></div>
    <div class="aim" id="aiM"><div class="b">Hi. Ask me anything about our services, hours or prices.</div></div>
    <form class="aif" onsubmit="return ksAsk(event)"><input id="aiI" placeholder="Type your question" autocomplete="off" /><button class="btn sm" type="submit">Send</button></form>
  </div>` : '';

  const analytics = has(s, 'P8')
    ? `<script>try{fetch('/api/site-action',{method:'POST',keepalive:true,headers:{'content-type':'application/json'},body:JSON.stringify({action:'view',slug:${JSON.stringify(s.slug)}})})}catch(e){}</script>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${e(title)}</title>
<meta name="description" content="${e(desc)}" />
<link rel="canonical" href="${canonical}" />
<meta property="og:title" content="${e(title)}" /><meta property="og:description" content="${e(desc)}" />
<meta property="og:type" content="website" /><meta property="og:url" content="${canonical}" />
${schema}
<link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?${theme.fonts}" rel="stylesheet" />
<style>
 :root{--ac:${accent};--bg:${theme.bg};--pn:${theme.pn};--ink:${theme.ink};--mut:${theme.mut};--ln:${theme.ln};--nav:${theme.nav};--alt:${theme.alt};--fld:${theme.fld};--on:${on};--fh:${theme.fh};--fb:${theme.fb}}
 *{box-sizing:border-box;margin:0;padding:0}
 body{background:var(--bg);color:var(--ink);font-family:var(--fb);line-height:1.6;overflow-wrap:break-word}
 a{color:inherit;text-decoration:none}
 h1,h2,h3{font-family:var(--fh);letter-spacing:-.02em;line-height:1.1}
 .wrap{max-width:1120px;margin:0 auto;padding:0 24px}
 .wrap.narrow{max-width:720px}
 .eyebrow{font-size:11.5px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--ac);margin-bottom:12px}
 /* ---- sticky bar with the call button, the demo's most useful idea ---- */
 nav{position:sticky;top:0;z-index:50;background:var(--nav);backdrop-filter:saturate(1.4) blur(12px);border-bottom:1px solid var(--ln)}
 .nv{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:13px 0}
 .logo{display:flex;align-items:center;gap:12px;min-width:0}
 .logo .mk{width:40px;height:40px;border-radius:11px;background:var(--ac);color:var(--on);display:grid;place-items:center;font-family:var(--fh);font-weight:800;font-size:15px;letter-spacing:0;text-transform:none;flex:none}
 .logo .nm{min-width:0}
 .logo .nm b{font-family:var(--fh);font-weight:800;font-size:1.02rem;display:block;line-height:1.2;letter-spacing:-.01em}
 .logo .nm i{display:block;font-style:normal;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--mut)}
 .nl{display:flex;gap:20px;flex-wrap:wrap}.nl a{color:var(--mut);font-size:.9rem}.nl a:hover{color:var(--ink)}
 .navcall{background:var(--ac);color:var(--on);border-radius:11px;padding:9px 15px;font-weight:700;font-size:.88rem;line-height:1.15;text-align:right;flex:none}
 .navcall small{display:block;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;opacity:.8;font-weight:600}
 /* ---- full-bleed hero. Depth from the accent, so it works light or dark ---- */
 .hero{position:relative;display:flex;align-items:center;padding:96px 0 84px;overflow:hidden}
 .hero-bg{position:absolute;inset:0;z-index:0;
   background:radial-gradient(1100px 700px at 78% 4%, color-mix(in srgb, var(--ac) 22%, transparent), transparent 62%),
              radial-gradient(900px 620px at 6% 100%, color-mix(in srgb, var(--ink) 10%, transparent), transparent 60%),
              linear-gradient(180deg, var(--alt), var(--bg))}
 .hero-bg::after{content:"";position:absolute;inset:0;background-image:repeating-linear-gradient(115deg,transparent,transparent 38px,color-mix(in srgb, var(--ink) 3%, transparent) 38px,color-mix(in srgb, var(--ink) 3%, transparent) 76px)}
 .hero .wrap{position:relative;z-index:1;max-width:860px}
 .pill{display:inline-block;border:1px solid var(--ln);background:color-mix(in srgb, var(--ink) 5%, transparent);border-radius:999px;padding:7px 14px;font-size:12.5px;font-weight:600;color:var(--mut)}
 .badge-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:26px}
 .hero h1{font-size:clamp(2.4rem,6.4vw,4.4rem);font-weight:800}
 .hero .sub{font-size:clamp(1.05rem,2.2vw,1.32rem);color:var(--mut);margin-top:20px;max-width:52ch}
 .cta{margin-top:32px;display:flex;gap:12px;flex-wrap:wrap}
 .btn{display:inline-block;background:var(--ac);color:var(--on);border:1px solid var(--ac);border-radius:12px;padding:14px 22px;font-weight:700;cursor:pointer;font-size:1rem;font-family:inherit;line-height:1.2}
 .btn small{display:block;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;opacity:.82;font-weight:600;margin-top:3px}
 .btn:hover{filter:brightness(1.07)} .btn.sm{padding:10px 15px;font-size:.88rem}
 .btn.ghost{background:transparent;color:var(--ink);border-color:var(--ln)}
 /* ---- band, sections, cards ---- */
 .band{background:var(--alt);border-top:1px solid var(--ln);border-bottom:1px solid var(--ln)}
 .band .wrap{display:flex;gap:44px;flex-wrap:wrap;padding-top:26px;padding-bottom:26px}
 .stat .n{font-family:var(--fh);font-weight:800;font-size:1.5rem;line-height:1.2}
 .stat .l{font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);margin-top:4px}
 .sec{padding:76px 0;border-top:1px solid var(--ln)}
 .sec.alt{background:var(--pn)}
 .sec-head{max-width:640px;margin-bottom:38px}
 .sec h2{font-size:clamp(1.6rem,3.4vw,2.2rem);font-weight:800}
 .lead{color:var(--mut);margin-top:10px;max-width:60ch}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:16px}
 .grid>*{min-width:0}
 .card{background:var(--alt);border:1px solid var(--ln);border-radius:16px;padding:26px 24px;transition:border-color .2s ease,transform .2s ease}
 .card:hover{border-color:var(--ac);transform:translateY(-2px)}
 .sec.alt .card{background:var(--bg)}
 .card .ic{width:46px;height:46px;border-radius:12px;background:color-mix(in srgb, var(--ac) 14%, transparent);color:var(--ac);display:grid;place-items:center;margin-bottom:16px}
 .card h3{font-size:1.06rem;font-weight:700} .card p{color:var(--mut);font-size:.93rem;margin-top:6px}
 .card .dt{font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);margin-bottom:6px}
 /* ---- contact ---- */
 .cts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:34px}
 .cts>div{min-width:0} .cts a{overflow-wrap:anywhere}
 .big{font-family:var(--fh);font-size:1.5rem;font-weight:800;color:var(--ac);display:inline-block}
 .info{margin-top:22px}
 .hrs{display:grid;gap:7px;max-width:340px}
 .hrs div{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid var(--ln);padding-bottom:6px;font-size:.94rem}
 .hrs span{color:var(--mut)}
 .bk,.cf{display:grid;gap:11px;max-width:460px}
 .bk input,.cf input,.cf textarea{padding:13px 15px;border:1px solid var(--ln);border-radius:11px;background:var(--fld);font:inherit;font-size:1rem;color:var(--ink);width:100%}
 .cf textarea{resize:vertical;min-height:96px}
 .bk input:focus,.cf input:focus,.cf textarea:focus{outline:none;border-color:var(--ac)}
 .bk .btn,.cf .btn{justify-self:start}
 /* SPECIFICITY, not order, decides this. The rule '.cf input' is (0,1,1) and
    a bare '.hp' is (0,1,0), so the honeypot inherited width:100% and padding
    from the field rule above and rendered 1425px wide, absolutely positioned,
    shoving the page 736px sideways at 1440. Scoping to '.cf .hp' (0,2,1) wins.
    The same collision exists in the classic layout and is merely invisible
    there, because its form sits far enough left that the overflow lands inside
    the viewport. Reported, not fixed here: this slice is the Trade port. */
 .cf .hp{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
 .fine{font-size:.88rem;color:var(--mut)}
 .embed iframe{width:100%;height:640px;border:1px solid var(--ln);border-radius:16px;background:var(--fld)}
 footer{border-top:1px solid var(--ln);padding:30px 0 38px;color:var(--mut);font-size:.86rem}
 footer a{border-bottom:1px solid var(--ln)}
 /* ---- assistant ---- */
 .aibtn{position:fixed;right:18px;bottom:18px;z-index:60;background:var(--ac);color:var(--on);border:0;border-radius:999px;padding:14px 20px;font:inherit;font-weight:700;cursor:pointer;box-shadow:0 10px 30px -10px rgba(0,0,0,.4)}
 .aip{position:fixed;right:18px;bottom:18px;z-index:61;width:min(370px,calc(100vw - 36px));background:var(--fld);border:1px solid var(--ln);border-radius:16px;display:none;overflow:hidden;box-shadow:0 24px 60px -20px rgba(0,0,0,.35)}
 .aip.open{display:block}
 .aih{display:flex;justify-content:space-between;align-items:center;padding:13px 16px;border-bottom:1px solid var(--ln)}
 .aih button{background:none;border:0;font-size:1.3rem;cursor:pointer;color:var(--mut)}
 .aim{padding:14px 16px;max-height:320px;overflow:auto;display:flex;flex-direction:column;gap:9px}
 .aim .b,.aim .u{padding:10px 13px;border-radius:12px;font-size:.93rem;max-width:88%}
 .aim .b{background:var(--bg);align-self:flex-start} .aim .u{background:var(--ac);color:var(--on);align-self:flex-end}
 .aif{display:flex;gap:8px;padding:12px 14px;border-top:1px solid var(--ln)}
 .aif input{flex:1;padding:10px 13px;border:1px solid var(--ln);border-radius:10px;font:inherit}
 .aif input:focus{outline:none;border-color:var(--ac)}
 @media(max-width:640px){.nl{display:none}.hero{padding:64px 0 56px}.band .wrap{gap:26px}}
</style>
</head>
<body>
<nav><div class="wrap nv">
  <a href="#" class="logo"><span class="mk">${e(initials)}</span><span class="nm"><b>${e(s.business)}</b>${cityState ? `<i>${e(cityState)}</i>` : ''}</span></a>
  <div class="nl">${nav}</div>
  ${s.phone ? `<a class="navcall" href="${telHref(s.phone)}">${e(s.phone)}<small>Call us</small></a>` : ''}
</div></nav>

<header class="hero">
  <div class="hero-bg" aria-hidden="true"></div>
  <div class="wrap">
    ${badges ? `<div class="badge-row">${badges}</div>` : ''}
    <h1>${e(s.business)}</h1>
    ${s.tagline ? `<p class="sub">${e(s.tagline)}</p>` : ''}
    ${heroCta ? `<div class="cta">${heroCta}</div>` : ''}
  </div>
</header>
${band}
${services}${updates}${booking}${pay}${about}

<section class="sec alt" id="contact"><div class="wrap">
  <div class="sec-head"><div class="eyebrow">Contact</div><h2>Find us</h2></div>
  <div class="cts">
    <div>
      ${s.phone ? `<a class="big" href="${telHref(s.phone)}">${e(s.phone)}</a><br>` : ''}
      ${s.email_public ? `<a href="mailto:${e(s.email_public)}">${e(s.email_public)}</a><br>` : ''}
      ${addr ? `<p style="color:var(--mut);margin-top:10px">${e(addr)}</p>` : ''}
      ${hours}
    </div>
    <div>
      <div class="eyebrow">Send a message</div>
      <form class="cf" onsubmit="return ksSend(event)">
        <input name="name" placeholder="Your name" required />
        <input name="contact" placeholder="Phone or email" required />
        <textarea name="message" placeholder="How can we help?" required></textarea>
        <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" />
        <button class="btn" type="submit">Send</button>
        <p class="fine" id="cfMsg"></p>
      </form>
    </div>
  </div>
</div></section>

<footer><div class="wrap">&copy; ${new Date().getFullYear()} ${e(s.business)}. Site by <a href="${base}">Killswitch Websites</a></div></footer>
${ai}
<script>
var SLUG=${JSON.stringify(s.slug)};
function post(action,payload,el){el.textContent='Sending...';return fetch('/api/site-action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({action:action,slug:SLUG},payload))}).then(function(r){return r.json().catch(function(){return{};});});}
function ksSend(ev){ev.preventDefault();var f=ev.target,m=document.getElementById('cfMsg');if(f.website.value)return false;post('contact',{name:f.name.value,contact:f.contact.value,message:f.message.value},m).then(function(d){m.textContent=d&&d.ok?'Thanks. We will be in touch.':'That did not send. Please call us instead.';if(d&&d.ok)f.reset();});return false;}
function ksBook(ev){ev.preventDefault();var f=ev.target,m=document.getElementById('bkMsg');post('book',{name:f.name.value,contact:f.contact.value,when:f.when.value},m).then(function(d){m.textContent=d&&d.ok?'Thanks. We will confirm shortly.':'That did not send. Please call us instead.';if(d&&d.ok)f.reset();});return false;}
${has(s, 'P9') ? `
var aiP=document.getElementById('aiP');
document.getElementById('aiBtn').onclick=function(){aiP.classList.add('open');};
document.getElementById('aiX').onclick=function(){aiP.classList.remove('open');};
function ksAsk(ev){ev.preventDefault();var i=document.getElementById('aiI'),m=document.getElementById('aiM'),q=i.value.trim();if(!q)return false;i.value='';var u=document.createElement('div');u.className='u';u.textContent=q;m.appendChild(u);var b=document.createElement('div');b.className='b';b.textContent='...';m.appendChild(b);m.scrollTop=m.scrollHeight;fetch('/api/site-action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'ask',slug:SLUG,question:q})}).then(function(r){return r.json().catch(function(){return{};});}).then(function(d){b.textContent=(d&&d.answer)||'Sorry, I could not answer that. Please call us.';m.scrollTop=m.scrollHeight;});return false;}` : ''}
</script>
${analytics}
</body>
</html>`;
}
