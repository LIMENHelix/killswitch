// MAKING THE SWITCHES DO SOMETHING ON A PAGE WE DID NOT TEMPLATE.
//
// The gap this closes: api/site.js serves `site.html` verbatim whenever a
// business has its own written page, and every module gate lives in
// lib/site-template.js, which that path skips entirely. So a customer with a
// hand-built or Opus-written page could buy P9, flip it on, watch the switch go
// green, and nothing would ever appear on their website. The panel was a light
// switch wired to nothing for exactly the customers whose sites we care most
// about. That is the product's core promise failing silently.
//
// This injects the same modules into arbitrary HTML at serve time, the way
// enforceRobots already rewrites stored HTML on every request rather than
// trusting what was saved. Switching a module on or off takes effect on the
// next page load, with nothing re-generated and nothing re-saved.
//
// TWO RULES IT WILL NOT BREAK:
//
// 1. NOTHING IS INSERTED INTO THEIR LAYOUT. A customer's page is theirs, and
//    blindly splicing a booking section into the middle of a design we did not
//    make would wreck it. Everything here is either invisible (schema, beacon)
//    or floats above the page in a corner (assistant, book, pay). A page that
//    wants a module placed exactly somewhere says so with a marker.
// 2. EVERYTHING IS SELF-CONTAINED AND NAMESPACED. The template's widget relies
//    on the template's stylesheet, so it cannot be reused here. These carry
//    their own CSS under a ksm- prefix and keep their JS on one global, so they
//    cannot collide with whatever the customer's own page already defines.

import { has } from './sites.js';

const e = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Insert before the last closing tag, or append when the page has no such tag. */
function insertBefore(html, tag, block) {
  if (!block) return html;
  const i = html.toLowerCase().lastIndexOf('</' + tag + '>');
  return i < 0 ? html + block : html.slice(0, i) + block + html.slice(i);
}

// ---- P1: the listing markup search engines read -------------------------------
function schemaFor(s) {
  const data = {
    '@context': 'https://schema.org', '@type': 'LocalBusiness',
    name: s.business || undefined,
    telephone: s.phone || undefined,
    url: s.siteUrl || undefined,
    sameAs: s.googleBusinessProfile ? [s.googleBusinessProfile] : undefined,
  };
  if (s.street || s.city || s.state || s.zip) {
    data.address = {
      '@type': 'PostalAddress',
      streetAddress: s.street || undefined, addressLocality: s.city || undefined,
      addressRegion: s.state || undefined, postalCode: s.zip || undefined,
    };
  }
  // JSON goes inside a <script>, so the one sequence that can break out of it
  // is a literal </script>. Escaping the slash keeps it valid JSON either way.
  const json = JSON.stringify(data).replace(/<\//g, '<\\/');
  return `<script type="application/ld+json">${json}</script>`;
}

// ---- P2: updates, placed only where the page explicitly opts in ----------------
// A stream of articles is real page content, not a floating utility. Custom
// pages therefore receive it only at a module marker; pages without one keep
// their layout untouched.
function updates(s) {
  if (!has(s, 'P2') || !Array.isArray(s.posts) || !s.posts.length) return '';
  return `<section class="ksm-updates" aria-labelledby="ksmUpdatesTitle">
  <div class="ksm-updates-in">
    <h2 id="ksmUpdatesTitle">Latest from ${e(s.business || 'us')}</h2>
    <div class="ksm-update-grid">${s.posts.slice(0, 3).map((p) => `<article class="ksm-update">
      ${p.date ? `<div class="ksm-update-date">${e(p.date)}</div>` : ''}
      <h3>${e(p.title || 'Update')}</h3>${p.body ? `<p>${e(p.body)}</p>` : ''}
    </article>`).join('')}</div>
  </div>
</section>`;
}

// ---- P3 / P7: floating actions, never spliced into their layout ---------------
function actionButtons(s) {
  const out = [];
  let bookingPanel = '';
  if (has(s, 'P3') && s.bookingUrl) out.push(`<a class="ksm-fab ksm-book" href="${e(s.bookingUrl)}" target="_blank" rel="noopener">Book online</a>`);
  if (has(s, 'P3') && !s.bookingUrl) {
    out.push('<button class="ksm-fab ksm-book" id="ksmBookBtn" type="button">Request a time</button>');
    bookingPanel = `<div class="ksm-book-panel" id="ksmBookPanel" hidden>
  <div class="ksm-panel-h"><b>Request a time</b><button type="button" id="ksmBookX" aria-label="Close">&times;</button></div>
  <form class="ksm-book-form" id="ksmBookForm">
    <input name="name" placeholder="Your name" required maxlength="80" />
    <input name="phone" placeholder="Your phone" required maxlength="40" />
    <input name="when" placeholder="Day and time that suits you" maxlength="160" />
    <button type="submit">Send request</button><p class="ksm-note" id="ksmBookNote"></p>
  </form>
</div>`;
  }
  if (has(s, 'P7') && s.payUrl) out.push(`<a class="ksm-fab ksm-pay" href="${e(s.payUrl)}" target="_blank" rel="noopener">Pay online</a>`);
  return out.length ? `<div class="ksm-fabs">${out.join('')}</div>${bookingPanel}` : '';
}

// ---- P9: the assistant, self-contained ---------------------------------------
function assistant(s) {
  if (!has(s, 'P9')) return '';
  return `<button class="ksm-ai-btn" id="ksmAiBtn" type="button">Ask a question</button>
<div class="ksm-ai" id="ksmAi" hidden>
  <div class="ksm-ai-h"><b>Ask ${e(s.business || 'us')}</b><button type="button" id="ksmAiX" aria-label="Close">&times;</button></div>
  <div class="ksm-ai-m" id="ksmAiM"><div class="ksm-b">Hi. Ask me anything about our services, hours or prices.</div></div>
  <form class="ksm-ai-f" id="ksmAiF"><input id="ksmAiI" placeholder="Type your question" autocomplete="off" /><button type="submit">Send</button></form>
</div>`;
}

const STYLE = `<style>
.ksm-fabs{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;align-items:flex-end}
.ksm-fab{font:600 15px/1 system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#fff;background:#12703C;padding:13px 18px;border-radius:999px;text-decoration:none;box-shadow:0 6px 20px rgba(0,0,0,.28)}
.ksm-fab:is(button){border:0;cursor:pointer}
.ksm-pay{background:#15161a}
.ksm-ai-btn{position:fixed;left:16px;bottom:16px;z-index:2147483000;font:600 15px/1 system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#fff;background:#15161a;border:0;padding:13px 18px;border-radius:999px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.28)}
.ksm-ai{position:fixed;right:16px;bottom:16px;z-index:2147483001;width:min(360px,calc(100vw - 32px));background:#fff;color:#15161a;border-radius:14px;overflow:hidden;box-shadow:0 14px 44px rgba(0,0,0,.32);font:15px/1.45 system-ui,-apple-system,Segoe UI,Arial,sans-serif}
.ksm-ai[hidden]{display:none}
.ksm-ai-h{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#15161a;color:#fff}
.ksm-ai-h button{background:0;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer}
.ksm-ai-m{padding:12px 14px;max-height:46vh;overflow:auto;display:flex;flex-direction:column;gap:8px}
.ksm-ai-m .ksm-b,.ksm-ai-m .ksm-u{padding:9px 12px;border-radius:11px;max-width:85%;white-space:pre-wrap;overflow-wrap:anywhere}
.ksm-ai-m .ksm-b{background:#f1f1f3;align-self:flex-start}
.ksm-ai-m .ksm-u{background:#12703C;color:#fff;align-self:flex-end}
.ksm-ai-f{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #e8e8ea}
.ksm-ai-f input{flex:1;min-width:0;padding:10px 12px;border:1px solid #d7d7db;border-radius:9px;font:inherit}
.ksm-ai-f button{background:#12703C;color:#fff;border:0;padding:10px 15px;border-radius:9px;font:600 15px/1 inherit;cursor:pointer}
.ksm-book-panel{position:fixed;right:16px;bottom:16px;z-index:2147483002;width:min(360px,calc(100vw - 32px));background:#fff;color:#15161a;border-radius:14px;overflow:hidden;box-shadow:0 14px 44px rgba(0,0,0,.32);font:15px/1.45 system-ui,-apple-system,Segoe UI,Arial,sans-serif}
.ksm-book-panel[hidden]{display:none}.ksm-panel-h{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#12703C;color:#fff}.ksm-panel-h button{background:0;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer}
.ksm-book-form{display:grid;gap:9px;padding:14px}.ksm-book-form input{padding:10px 12px;border:1px solid #d7d7db;border-radius:9px;font:inherit}.ksm-book-form>button{background:#12703C;color:#fff;border:0;padding:11px 15px;border-radius:9px;font:600 15px/1 system-ui;cursor:pointer}.ksm-note{min-height:1.4em;margin:0;color:#555;font-size:13px}
.ksm-updates{padding:52px 20px;background:#f5f5f5;color:#171717;font:16px/1.55 system-ui,-apple-system,Segoe UI,Arial,sans-serif}.ksm-updates-in{max-width:1080px;margin:0 auto}.ksm-updates h2{margin:0 0 18px;font:700 clamp(26px,4vw,38px)/1.15 system-ui,-apple-system,Segoe UI,Arial,sans-serif}.ksm-update-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(230px,100%),1fr));gap:14px}.ksm-update{padding:20px;background:#fff;border:1px solid #ddd;border-radius:12px}.ksm-update h3{margin:0 0 7px;font:700 18px/1.25 system-ui,-apple-system,Segoe UI,Arial,sans-serif}.ksm-update p{margin:0;color:#555}.ksm-update-date{margin-bottom:7px;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.08em}
@media print{.ksm-fabs,.ksm-ai-btn,.ksm-ai{display:none!important}}
</style>`;

function script(s, page) {
  const slug = JSON.stringify(s.slug || '');
  const wantsAi = has(s, 'P9');
  const wantsView = has(s, 'P8');
  const wantsBook = has(s, 'P3') && !s.bookingUrl;
  // quoteForm is the contract used by the seven production demo designs before
  // data-ks-contact existed. Supporting it here upgrades already-stored copies;
  // changing the source demo file alone cannot rewrite HTML in customer data.
  const wantsContact = /data-ks-contact(?:\s|=|>)/i.test(page || '')
    || /<form[^>]+id=["']quoteForm["']/i.test(page || '');
  if (!wantsAi && !wantsView && !wantsBook && !wantsContact) return '';
  return `<script>(function(){var S=${slug};
${wantsView ? `try{fetch('/api/site-action',{method:'POST',keepalive:true,headers:{'content-type':'application/json'},body:JSON.stringify({action:'view',slug:S})})}catch(e){}` : ''}
${wantsContact ? `document.addEventListener('submit',function(ev){var f=ev.target&&ev.target.closest?ev.target.closest('form[data-ks-contact],form#quoteForm'):null;if(!f)return;
var fd=new FormData(f),name=String(fd.get('name')||'').trim(),contact=String(fd.get('contact')||fd.get('phone')||fd.get('email')||'').trim(),message=String(fd.get('message')||'').trim(),more=[];if(!name||!contact||!message)return;ev.preventDefault();ev.stopImmediatePropagation();
fd.forEach(function(v,k){if(['name','contact','phone','email','message','website'].indexOf(k)<0&&String(v||'').trim())more.push(k+': '+String(v).trim())});
if(more.length)message+=(message?'\\n\\n':'')+more.join('\\n');var n=f.querySelector('[data-ks-status],.ok'),b=f.querySelector('[type="submit"]');if(n){n.hidden=false;n.textContent='Sending…'}if(b)b.disabled=true;
fetch('/api/site-action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'contact',slug:S,name:name,contact:contact,message:message,website:String(fd.get('website')||'')})})
.then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d}})}).then(function(x){if(!x.ok||!x.d.ok)throw new Error();if(n){n.hidden=false;n.textContent='Sent. We will be in touch shortly.'}f.reset()})
.catch(function(){if(n){n.hidden=false;n.textContent='That did not send. Please call us instead.'}}).then(function(){if(b)b.disabled=false});
},true);` : ''}
${wantsBook ? `var bb=document.getElementById('ksmBookBtn'),bp=document.getElementById('ksmBookPanel'),bx=document.getElementById('ksmBookX'),bf=document.getElementById('ksmBookForm'),bn=document.getElementById('ksmBookNote');
if(bb&&bp&&bf){bb.onclick=function(){bp.hidden=false};if(bx)bx.onclick=function(){bp.hidden=true};bf.onsubmit=function(ev){ev.preventDefault();var fd=new FormData(bf),sb=bf.querySelector('[type="submit"]');bn.textContent='Sending…';if(sb)sb.disabled=true;
fetch('/api/site-action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'book',slug:S,name:String(fd.get('name')||''),phone:String(fd.get('phone')||''),when:String(fd.get('when')||'')})})
.then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d}})}).then(function(x){if(!x.ok||!x.d.ok)throw new Error();bn.textContent='Sent. We will confirm shortly.';bf.reset()}).catch(function(){bn.textContent='That did not send. Please call us instead.'}).then(function(){if(sb)sb.disabled=false});return false}}` : ''}
${wantsAi ? `var btn=document.getElementById('ksmAiBtn'),box=document.getElementById('ksmAi'),m=document.getElementById('ksmAiM'),f=document.getElementById('ksmAiF'),i=document.getElementById('ksmAiI'),H=[];
if(btn&&box){btn.onclick=function(){box.hidden=false;btn.style.display='none';i&&i.focus()};
document.getElementById('ksmAiX').onclick=function(){box.hidden=true;btn.style.display='block'};
f.onsubmit=function(ev){ev.preventDefault();var q=i.value.trim();if(!q)return false;i.value='';
var u=document.createElement('div');u.className='ksm-u';u.textContent=q;m.appendChild(u);
var b=document.createElement('div');b.className='ksm-b';b.textContent='\\u2026';m.appendChild(b);m.scrollTop=m.scrollHeight;
H.push({role:'user',content:q});
fetch('/api/site-action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'ask',slug:S,messages:H.slice(-8)})})
.then(function(r){return r.json()}).then(function(d){b.textContent=(d&&d.reply)||'Sorry, I could not answer that. Please call us.';
H.push({role:'assistant',content:b.textContent});m.scrollTop=m.scrollHeight})
.catch(function(){b.textContent='Sorry, I could not answer that. Please call us.'});return false}}` : ''}
})();</script>`;
}

/**
 * Apply the customer's switched-on modules to a page we did not template.
 *
 * @param {string} html the stored page, exactly as saved
 * @param {object} site the site record, whose `modules` array is the on/off state
 * @returns {string} the same page with the on modules applied
 *
 * Safe on junk: anything unparseable returns the original HTML untouched,
 * because serving their real page without a module beats serving a broken one.
 */
export function applyModules(html, site) {
  const s = site || {};
  const page = String(html || '');
  if (!page.trim()) return page;

  try {
    const head = has(s, 'P1') ? schemaFor(s) : '';
    const MARKER = '<!--ks:modules-->';
    const updateBlock = updates(s);
    const body = assistant(s) + actionButtons(s);
    const js = script(s, page);
    if (!head && !updateBlock && !body && !js) return page;

    let out = head ? insertBefore(page, 'head', head) : page;
    const at = out.indexOf(MARKER);
    let stylePlaced = false;

    // A page that wants content modules somewhere specific says so. The older
    // demo pages predate the marker but all use <section class="final"> for the
    // contact area, so that stable boundary upgrades already-stored copies too.
    if (at >= 0 && (updateBlock || body)) {
      out = out.slice(0, at) + STYLE + updateBlock + body + out.slice(at + MARKER.length);
      stylePlaced = true;
    } else if (updateBlock) {
      const legacyAt = out.search(/<section\s+class=["'][^"']*\bfinal\b[^"']*["'][^>]*>/i);
      if (legacyAt >= 0) {
        out = out.slice(0, legacyAt) + STYLE + updateBlock + out.slice(legacyAt);
        stylePlaced = true;
      }
    }

    // Utilities can safely float above an arbitrary layout. Append those and
    // all behavior at the end when no explicit placement consumed them.
    if (at < 0 && body) out = insertBefore(out, 'body', (stylePlaced ? '' : STYLE) + body);
    if (js) out = insertBefore(out, 'body', js);
    return out;
  } catch (err) {
    console.error('[site-modules] apply', err);
    return page;
  }
}

/** Which modules this file can actually put on a page, for /master to tell the truth with. */
export const INJECTABLE = ['P1', 'P2', 'P3', 'P7', 'P8', 'P9'];

/**
 * Re-root a page's relative links so it survives being served from a new address.
 *
 * A page written at /demos/x.html can say src="assets/logo.jpg" and be right.
 * Serve the same bytes from /s/x and the browser resolves that against /s/,
 * which is a 404, and the business's logo silently disappears from their own
 * website. Nothing errors: the HTML is valid, the file is there, the address
 * moved. This rewrites every relative reference to point at the directory the
 * page actually came from, once, when it is imported.
 *
 * Absolute URLs, protocol-relative URLs, data:, mailto:, tel: and #anchors are
 * all left exactly as they are.
 *
 * @param {string} html the page as written
 * @param {string} from  where it was fetched from, e.g. '/demos/their-page'
 */
export function rerootRelativeUrls(html, from) {
  const page = String(html || '');
  const src = String(from || '').split(/[?#]/)[0];
  if (!page || !src) return page;
  // '/demos/their-page' -> '/demos/'. A path with no slash
  // beyond the first cannot tell us a directory, so nothing is changed.
  const dir = src.replace(/\/[^/]*$/, '/');
  if (!dir || dir === '/') return page;

  const isAbsolute = (u) => !u
    || /^[a-z][a-z0-9+.-]*:/i.test(u)   // http:, https:, data:, mailto:, tel:
    || u.startsWith('//')                // protocol-relative
    || u.startsWith('/')                 // already rooted
    || u.startsWith('#');                // in-page anchor
  const fix = (u) => (isAbsolute(u) ? u : dir + u.replace(/^\.\//, ''));

  try {
    return page
      // src="…", href="…", poster="…"
      .replace(/(\s(?:src|href|poster)\s*=\s*)(["'])([^"']*)\2/gi,
        (m, pre, q, u) => pre + q + fix(u.trim()) + q)
      // srcset="a.jpg 1x, b.jpg 2x" — each candidate is a URL plus a descriptor
      .replace(/(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi, (m, pre, q, list) => pre + q + list
        .split(',')
        .map((part) => {
          const t = part.trim();
          if (!t) return t;
          const sp = t.indexOf(' ');
          return sp < 0 ? fix(t) : fix(t.slice(0, sp)) + t.slice(sp);
        })
        .join(', ') + q)
      // CSS url(...) in inline styles and <style> blocks
      .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
        (m, q, u) => 'url(' + q + fix(u.trim()) + q + ')');
  } catch (err) {
    console.error('[site-modules] reroot', err);
    return page;
  }
}
