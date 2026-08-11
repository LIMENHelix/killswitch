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

export function renderSite(site, opts = {}) {
  const s = site;
  const accent = /^#[0-9a-fA-F]{6}$/.test(s.accent || '') ? s.accent : '#12703C';
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
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
 :root{--ac:${accent};--bg:#F6F1E7;--pn:#fff;--ink:#1E1B16;--mut:#5A5347;--ln:#D8CFBC}
 *{box-sizing:border-box;margin:0;padding:0}
 /* This template renders whatever a real business is called and however long
    their email is, so nothing here can assume a word fits. A single long token,
    servicedesk@gonzalezandsonsautomotive.com say, used to push the contact block
    63px past the screen on a phone. */
 body{background:var(--bg);color:var(--ink);font-family:"Inter",system-ui,sans-serif;line-height:1.6;overflow-wrap:break-word}
 a{color:inherit;text-decoration:none}
 h1,h2,h3{font-family:"Manrope",sans-serif;letter-spacing:-.02em;line-height:1.15}
 .wrap{max-width:1060px;margin:0 auto;padding:0 22px}
 nav{position:sticky;top:0;z-index:40;background:rgba(246,241,231,.9);backdrop-filter:blur(8px);border-bottom:1px solid var(--ln)}
 .nv{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:15px 0;flex-wrap:wrap}
 .bn{font-family:"Manrope",sans-serif;font-weight:800;font-size:1.1rem}
 .nl{display:flex;gap:20px;flex-wrap:wrap}.nl a{color:var(--mut);font-size:.92rem}.nl a:hover{color:var(--ink)}
 .hero{padding:64px 0 52px}
 .hero h1{font-size:clamp(2rem,5vw,3.2rem);font-weight:800}
 .hero .tg{margin-top:14px;font-size:1.15rem;color:var(--mut);max-width:32em}
 .cta{margin-top:26px;display:flex;gap:12px;flex-wrap:wrap}
 .btn{display:inline-block;background:var(--ac);color:#fff;border:1px solid var(--ac);border-radius:11px;padding:13px 22px;font-weight:600;cursor:pointer;font-size:1rem;font-family:inherit}
 .btn:hover{filter:brightness(1.08)} .btn.sm{padding:9px 14px;font-size:.88rem}
 .btn.ghost{background:transparent;color:var(--ink);border-color:var(--ln)}
 .sec{padding:52px 0;border-top:1px solid var(--ln)}
 .sec.alt{background:var(--pn)} .sec.narrow p{max-width:60ch}
 .sec h2{font-size:1.7rem;font-weight:800;margin-bottom:8px}
 .lead{color:var(--mut);margin-bottom:22px;max-width:60ch}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:16px}
 .grid>*{min-width:0}
 .card{background:var(--bg);border:1px solid var(--ln);border-radius:14px;padding:20px}
 .sec.alt .card{background:#FBF8F2}
 .card h3{font-size:1.05rem;font-weight:700;margin-bottom:5px} .card p{color:var(--mut);font-size:.94rem}
 .card .dt{font-size:.74rem;color:var(--mut);text-transform:uppercase;letter-spacing:.08em;margin-bottom:5px}
 .hrs{display:grid;gap:7px;max-width:340px;margin-top:6px}
 .hrs div{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid var(--ln);padding-bottom:6px;font-size:.95rem}
 .hrs span{color:var(--mut)}
 .bk{display:grid;gap:11px;max-width:420px}
 .bk input{padding:13px 15px;border:1px solid var(--ln);border-radius:11px;background:#fff;font:inherit;font-size:1rem;color:var(--ink)}
 .bk input:focus{outline:none;border-color:var(--ac)}
 .cf{display:grid;gap:11px;max-width:460px}
 .cf h3{font-size:1.05rem;font-weight:700}
 .cf input,.cf textarea{padding:13px 15px;border:1px solid var(--ln);border-radius:11px;background:#fff;font:inherit;font-size:1rem;color:var(--ink);width:100%}
 .cf textarea{resize:vertical;min-height:96px}
 .cf input:focus,.cf textarea:focus{outline:none;border-color:var(--ac)}
 .cf .btn{justify-self:start}
 /* Honeypot. The old left:-9999px trick creates a real 10,000px-wide box off to
    the side, which an overflow audit flags and which can push a page sideways in
    some layouts. clip-path keeps it in the flow at zero size instead. */
 .hp{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
 .fine{font-size:.88rem;color:var(--mut)}
 .embed iframe{width:100%;height:640px;border:1px solid var(--ln);border-radius:14px;background:#fff}
 /* min() so the column can drop below 240px on a narrow phone instead of forcing
    the grid wider than the screen, and min-width:0 because a grid item defaults
    to min-width:auto, which refuses to shrink below its longest word. */
 .cts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:26px}
 .cts>div{min-width:0}
 .cts a{overflow-wrap:anywhere}
 .cts a.big{font-size:1.25rem;font-weight:700;color:var(--ac)}
 footer{border-top:1px solid var(--ln);padding:26px 0 34px;color:var(--mut);font-size:.86rem}
 footer a{border-bottom:1px solid var(--ln)}
 .aibtn{position:fixed;right:18px;bottom:18px;z-index:50;background:var(--ac);color:#fff;border:0;border-radius:999px;padding:14px 20px;font:inherit;font-weight:600;cursor:pointer;box-shadow:0 10px 30px -10px rgba(0,0,0,.4)}
 .aip{position:fixed;right:18px;bottom:18px;z-index:51;width:min(370px,calc(100vw - 36px));background:#fff;border:1px solid var(--ln);border-radius:16px;display:none;overflow:hidden;box-shadow:0 24px 60px -20px rgba(0,0,0,.35)}
 .aip.open{display:block}
 .aih{display:flex;justify-content:space-between;align-items:center;padding:13px 16px;border-bottom:1px solid var(--ln)}
 .aih button{background:none;border:0;font-size:1.3rem;cursor:pointer;color:var(--mut)}
 .aim{padding:14px 16px;max-height:320px;overflow:auto;display:flex;flex-direction:column;gap:9px}
 .aim .b,.aim .u{padding:10px 13px;border-radius:12px;font-size:.93rem;max-width:88%}
 .aim .b{background:#F6F1E7;align-self:flex-start} .aim .u{background:var(--ac);color:#fff;align-self:flex-end}
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
