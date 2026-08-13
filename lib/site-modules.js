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

// ---- P3 / P7: floating actions, never spliced into their layout ---------------
function actionButtons(s) {
  const out = [];
  if (has(s, 'P3') && s.bookingUrl) out.push(`<a class="ksm-fab ksm-book" href="${e(s.bookingUrl)}" target="_blank" rel="noopener">Book online</a>`);
  if (has(s, 'P7') && s.payUrl) out.push(`<a class="ksm-fab ksm-pay" href="${e(s.payUrl)}" target="_blank" rel="noopener">Pay online</a>`);
  return out.length ? `<div class="ksm-fabs">${out.join('')}</div>` : '';
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
.ksm-pay{background:#15161a}
.ksm-ai-btn{position:fixed;right:16px;bottom:16px;z-index:2147483000;font:600 15px/1 system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#fff;background:#15161a;border:0;padding:13px 18px;border-radius:999px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.28)}
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
@media print{.ksm-fabs,.ksm-ai-btn,.ksm-ai{display:none!important}}
</style>`;

function script(s) {
  const slug = JSON.stringify(s.slug || '');
  const wantsAi = has(s, 'P9');
  const wantsView = has(s, 'P8');
  if (!wantsAi && !wantsView) return '';
  return `<script>(function(){var S=${slug};
${wantsView ? `try{fetch('/api/site-action',{method:'POST',keepalive:true,headers:{'content-type':'application/json'},body:JSON.stringify({action:'view',slug:S})})}catch(e){}` : ''}
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
    const body = assistant(s) + actionButtons(s);
    const js = script(s);
    if (!head && !body && !js) return page;

    let out = head ? insertBefore(page, 'head', head) : page;
    const block = (body ? STYLE + body : '') + js;
    if (!block) return out;

    // A page that wants the modules somewhere specific says so. Everything else
    // gets them at the end of the body, floating, out of the way of a layout we
    // did not design.
    const MARKER = '<!--ks:modules-->';
    const at = out.indexOf(MARKER);
    out = at >= 0
      ? out.slice(0, at) + block + out.slice(at + MARKER.length)
      : insertBefore(out, 'body', block);
    return out;
  } catch (err) {
    console.error('[site-modules] apply', err);
    return page;
  }
}

/** Which modules this file can actually put on a page, for /master to tell the truth with. */
export const INJECTABLE = ['P1', 'P3', 'P7', 'P8', 'P9'];

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
 * @param {string} from  where it was fetched from, e.g. '/demos/oouwees-barbershop-gladstone'
 */
export function rerootRelativeUrls(html, from) {
  const page = String(html || '');
  const src = String(from || '').split(/[?#]/)[0];
  if (!page || !src) return page;
  // '/demos/oouwees-barbershop-gladstone' -> '/demos/'. A path with no slash
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
