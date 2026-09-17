// THE PUBLISH QUALITY GATE. One authoritative validator for "is this site
// credible enough to be public under a real business's name".
//
// Every publication path (admin site-publish, the voice agent, master go-live)
// and the K5 draft pipeline run through validatePublishable(). There is no
// second copy of these rules anywhere: a site that cannot pass here stays a
// draft, and the caller gets the exact reasons to show a human.
//
// WHAT IT MEASURES, and what it deliberately does not. It checks that the page
// a visitor would get is complete and factual: a real name, a real trade, a
// real place, a working contact path, at least one content section beyond the
// hero, and the SEO/schema output the template promises. It does NOT count
// words, does not demand marketing copy, and does not judge taste — a short,
// entirely factual site passes. Unknown facts are omitted by the generator
// (lib/site-seed.js, lib/draft-site.js); this gate only has to prove the
// known ones add up to a usable page.
//
// Sparse records are the point of the exercise: a name and nothing else fails
// with exact blockers and stays unpublished, rather than going live as four
// blocks and a phone number.

import { SITE_DEFAULT } from './sites.js';
import { renderSite } from './site-template.js';

// Placeholder-shaped content. Not a style guide: the exact markers of an
// unfinished record that must never be public under a business's name.
const PLACEHOLDER = /(lorem ipsum|placeholder\b|\bTBD\b|\bTODO\b|\bFIXME\b)/i;
// Template output escapes record fields, but script-shaped content has no
// legitimate place in business copy; refuse it visibly instead of shipping an
// escaped curiosity.
const UNSAFE = /(<\s*script|javascript\s*:|on\w+\s*=)/i;

const digits = (p) => String(p || '').replace(/\D/g, '');
const isEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || '').trim());

/**
 * Validate one site record for public/customer-ready publication.
 *
 * Runs the field checks AND renders the record through the real template, so
 * the SEO invariants (title, meta description, canonical, parseable business
 * schema naming the business, working contact form) are measured on the actual
 * output rather than assumed from the fields.
 *
 * @param {object} site a site record (partial is fine; defaults are merged)
 * @returns {{ ok: boolean, blockers: string[] }} exact, operator-readable reasons
 */
export function validatePublishable(site) {
  const s = { ...SITE_DEFAULT, ...(site || {}) };
  const blockers = [];

  const business = String(s.business || '').trim();
  if (!business) blockers.push('missing_business_name');

  const trade = String(s.trade || '').trim();
  if (!trade) blockers.push('no_usable_trade');

  const city = String(s.city || '').trim();
  const state = String(s.state || '').trim();
  if (!city && !state) blockers.push('no_usable_location');

  // A contact path is only checked when present: the contact form is on every
  // page, so a missing phone is a smaller site, not a broken one. A MALFORMED
  // one is a broken CTA.
  if (String(s.phone || '').trim() && digits(s.phone).length < 10) blockers.push('malformed_phone');
  if (String(s.email_public || '').trim() && !isEmail(s.email_public)) blockers.push('malformed_public_email');

  const publicText = [
    business, trade, s.tagline, s.about, s.street, city,
    ...(Array.isArray(s.services) ? s.services.map((x) => `${x && x.name} ${x && x.desc}`) : []),
    ...(Array.isArray(s.hours) ? s.hours.map((h) => `${h && h.d} ${h && h.h}`) : []),
  ].join('\n');
  if (PLACEHOLDER.test(publicText)) blockers.push('placeholder_content');
  if (UNSAFE.test(publicText)) blockers.push('unsafe_content');

  // Beyond hero + contact + footer there must be SOMETHING: a service list,
  // an about line, or opening hours. That is the difference between a website
  // and a business card, measured on sections, not on word count.
  const hasContent = (Array.isArray(s.services) && s.services.length > 0)
    || !!String(s.about || '').trim()
    || (Array.isArray(s.hours) && s.hours.length > 0);
  if (!hasContent) blockers.push('thin_render_no_content_sections');

  // The template's meta description falls back to "<name>." when there is no
  // tagline and not enough trade/place to build one — the measured defect on
  // the thin production sites. Require the inputs for a useful description.
  if (!String(s.tagline || '').trim() && !(trade && city)) blockers.push('missing_useful_meta_description');

  // Measure the actual render: the SEO head, the schema, and the working form.
  try {
    const html = renderSite({ ...s, modules: ['P0'] });
    if (!/<title>[^<]+<\/title>/.test(html)) blockers.push('render_missing_title');
    if (!/rel="canonical"/.test(html)) blockers.push('render_missing_canonical');
    if (!/property="og:title"/.test(html)) blockers.push('render_missing_og');
    if (!/name="message"/.test(html)) blockers.push('render_missing_contact_form');
    if (/>\s*undefined\s*</.test(html)) blockers.push('render_contains_undefined');
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (!m) {
      blockers.push('render_missing_business_schema');
    } else {
      try {
        const j = JSON.parse(m[1]);
        if (!j || !j.name || !j['@type']) blockers.push('schema_missing_name_or_type');
      } catch {
        blockers.push('schema_invalid_json');
      }
    }
  } catch {
    blockers.push('render_threw');
  }

  return { ok: blockers.length === 0, blockers: Array.from(new Set(blockers)) };
}

/** One operator-readable line, for logs and admin error messages. */
export function blockerSummary(blockers) {
  return (blockers || []).join('; ');
}
