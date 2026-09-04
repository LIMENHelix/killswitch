// Write one website per business, from a prompt about that business.
//
// The shared template still exists and still renders every site that has no
// generated HTML, so nothing is ever without a page. This gives a business its
// own page instead of the same page with its name in it, which is what the
// operator asked for: a simple prompt per business, not a template with fields.
//
// TWO THINGS ARE NOT LEFT TO THE MODEL, because they are not style questions:
//
//  1. FACTS. The prompt carries only what we actually hold about the business,
//     and says plainly that anything absent must be left out. A generated page
//     that invents opening hours or a founding year is worse than no page: the
//     first thing the owner reads about their own shop would be false.
//  2. INDEXABILITY. The noindex tag is injected here, after generation, from the
//     site's `claimed` flag. A business that has agreed to nothing must never be
//     indexed, and that guarantee cannot depend on a model remembering a rule.
//
// Direct fetch, no SDK: this project has no package.json and four existing
// Anthropic call sites all use fetch. Adding the SDK would introduce the first
// dependency and a build step to a Vercel project that has neither.

import { recordUsage } from './ai-usage.js';
import { externalSideEffectsAllowed } from './environment.js';

const API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-5';

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Only what we hold. Absent fields are absent from the brief, not blank in it. */
function brief(site) {
  const L = [];
  const add = (k, v) => { if (v && String(v).trim()) L.push(`${k}: ${String(v).trim()}`); };
  add('Business name', site.business);
  add('Trade', site.trade);
  add('Phone', site.phone);
  add('Email shown publicly', site.email_public);
  const addr = [site.street, site.city, site.state, site.zip].filter(Boolean).join(', ');
  add('Address', addr);
  add('Tagline they gave us', site.tagline);
  add('About, in their words', site.about);
  if (Array.isArray(site.hours) && site.hours.length) {
    add('Opening hours', site.hours.map((h) => `${h.d} ${h.h}`).join('; '));
  }
  if (Array.isArray(site.services) && site.services.length) {
    add('Services', site.services.map((s) => s.name + (s.desc ? ` (${s.desc})` : '')).join('; '));
  }
  if (Array.isArray(site.posts) && site.posts.length) {
    add('Updates to show', site.posts.map((p) => `${p.title}: ${p.body}`).join(' | '));
  }
  add('Online booking link', site.bookingUrl);
  add('Payment link', site.payUrl);
  add('Accent colour they picked', site.accent);
  return L.join('\n');
}

const SYSTEM = `You write a complete, single-file website for one local business. You are given only the facts we actually hold about that business. Return the HTML document and nothing else.

WHAT YOU MAY SAY
Use only the facts in the brief. If a fact is not in the brief, it does not go on the page. Do not invent opening hours, a founding year, staff names, prices, certifications, awards, review counts, years of experience, or claims about quality or speed. Do not write testimonials. Do not write "serving the community since". If the brief has no about text, write about what they do from the trade and location alone, in one or two plain sentences, or leave the section out. An owner is going to read this page about their own business, and anything untrue on it costs us the customer.

WHAT THE PAGE MUST DO
It must work on a phone first. The business name, what they do, where they are, and the phone number must be reachable within one screen. Make the phone number a tel: link. If there is a booking or payment link, make it a clear button. If there is an address, include it as text.

HOW IT SHOULD LOOK
Design it for this specific trade and this specific business, not from a template. A barbershop, a bakery, a roofer and a dental practice should not look alike. Pick a palette and typeface that suit the trade and the accent colour if one is given. Avoid generic AI-generated aesthetics: no Inter or Roboto or system-font defaults, no purple gradients, no cookie-cutter three-card layout. Use real visual character.

TECHNICAL
Return one complete HTML document starting with <!DOCTYPE html>. All CSS in a single <style> tag in the head. No external stylesheets, fonts, scripts, images or CDN links of any kind, because the page must render with no network. Use CSS for any visual interest instead of images. No tracking, no analytics, no forms that post anywhere. Include a <title> and a meta description. Do not include a robots meta tag; that is added afterwards.

Output the raw HTML only. No markdown fences, no explanation before or after.`;

/** Models sometimes wrap output in a fence even when told not to. */
function unfence(s) {
  const t = String(s || '').trim();
  const m = t.match(/^```(?:html)?\s*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : t).trim();
}

/**
 * The one rule that is not the model's to keep. An unclaimed business has agreed
 * to nothing, so its page must not be indexable no matter what the model wrote.
 */
function enforceRobots(html, claimed) {
  let out = html.replace(/<meta[^>]+name=["']robots["'][^>]*>\s*/gi, '');
  if (!claimed) {
    out = out.replace(/<head(\s[^>]*)?>/i, (m) => m + '\n<meta name="robots" content="noindex, nofollow" />');
  }
  return out;
}

function validate(html) {
  if (!html || html.length < 800) return 'output too short to be a page';
  if (!/^<!DOCTYPE html>/i.test(html)) return 'does not start with a doctype';
  if (!/<\/html>\s*$/i.test(html)) return 'is not a complete document';
  if (!/<title>/i.test(html)) return 'has no title';
  if (/<script\b/i.test(html)) return 'contains executable script';
  if (/\son[a-z]+\s*=/i.test(html)) return 'contains an inline event handler';
  if (/javascript\s*:/i.test(html)) return 'contains a javascript URL';
  // Must render with no network: the page has to work the moment it is published.
  if (/<(?:script|link|img|iframe)[^>]+(?:src|href)\s*=\s*["']https?:/i.test(html)) return 'references an external resource';
  return null;
}

/**
 * @param {object} site a site record
 * @param {object} [opts] {extra} free-text direction from the operator
 * @returns {Promise<{ok:true, html:string, bytes:number}|{ok:false, error:string}>}
 */
export async function writeSite(site, opts = {}) {
  if (!externalSideEffectsAllowed()) return { ok: false, error: 'preview side effects disabled' };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: 'ANTHROPIC_API_KEY not set' };
  if (!site || !site.business) return { ok: false, error: 'no business name' };

  const facts = brief(site);
  const extra = String(opts.extra || '').trim().slice(0, 800);
  const prompt = `Write the website for this business.

FACTS WE HOLD (everything you are allowed to state):
${facts}
${extra ? `\nDIRECTION FROM THE OPERATOR:\n${extra}\n` : ''}
Remember: anything not listed above does not appear on the page.`;

  let r;
  try {
    r = await fetch(API, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 24000,
        // Adaptive is the default on this model; stated so the intent is visible.
        // Low effort because writing a one-page site from a fixed brief is a
        // generation task, not a reasoning one, and it keeps thinking out of the
        // token budget that the HTML itself needs.
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (e) {
    console.error('[site-writer] fetch', e);
    return { ok: false, error: 'could not reach the model' };
  }

  const data = await r.json().catch(() => ({}));
  // The single most expensive call in the system, and a ONE-TIME cost per page
  // rather than a recurring one. Every regeneration while getting a site right
  // is another one of these, which is the number worth knowing.
  await recordUsage({ model: MODEL, usage: data.usage, where: 'site-writer' });
  if (!r.ok) {
    console.error('[site-writer] anthropic', r.status, JSON.stringify(data).slice(0, 300));
    return { ok: false, error: 'model error ' + r.status };
  }
  // Safety classifiers can decline; that arrives as a 200, not an error.
  if (data.stop_reason === 'refusal') return { ok: false, error: 'the model declined to write this one' };
  if (data.stop_reason === 'max_tokens') return { ok: false, error: 'page was cut off, try again' };

  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let html = enforceRobots(unfence(text), !!site.claimed);
  const bad = validate(html);
  if (bad) {
    console.error('[site-writer] rejected:', bad, 'for', site.slug);
    return { ok: false, error: 'generated page ' + bad };
  }
  return { ok: true, html, bytes: html.length };
}

/** Re-apply the index rule to stored HTML when a site is claimed or unclaimed. */
export { enforceRobots };
