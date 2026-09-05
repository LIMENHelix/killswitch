// Operator notifications. The system used to tell nobody when a customer started
// or stopped paying, or when autopilot switched itself off; you found out by
// remembering to look. This closes that.
//
// FIRE AND FORGET, ALWAYS. A failure here must never break the thing that
// triggered it: a customer flipping a switch must succeed even if Resend is down,
// the key is missing, or the address is unset. Every path returns a result object
// and nothing in this file ever throws.
//
// Env: RESEND_API_KEY (required to send), KS_NOTIFY_EMAIL (where to send),
//      KS_FROM_EMAIL (optional sender override).

import { externalSideEffectsAllowed } from './environment.js';

const FROM_DEFAULT = 'Killswitch Websites <hello@killswitch.domains>';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {object}   o
 * @param {string}   o.subject  email subject, already human-readable
 * @param {string}   o.heading  big line at the top of the mail
 * @param {string[]} o.lines    body lines, plain strings
 * @param {string}  [o.url]     optional call-to-action link
 * @param {string}  [o.urlText] label for that link
 * @returns {Promise<{sent:boolean, reason?:string}>} never rejects
 */
export async function notifyOperator({ subject, heading, lines = [], url, urlText }) {
  try {
    if (!externalSideEffectsAllowed()) return { sent: false, reason: 'preview_side_effects_disabled' };
    const key = process.env.RESEND_API_KEY;
    const to = (process.env.KS_NOTIFY_EMAIL || '').trim();

    // Fail QUIET but LOUD in logs: silence here is what caused the original gap.
    if (!key) { console.error('[notify] skipped, RESEND_API_KEY unset:', subject); return { sent: false, reason: 'no_api_key' }; }
    if (!to) { console.error('[notify] skipped, KS_NOTIFY_EMAIL unset:', subject); return { sent: false, reason: 'no_recipient' }; }

    const body = lines.map((l) => `<p style="margin:0 0 7px">${esc(l)}</p>`).join('');
    const cta = url
      ? `<p style="margin:18px 0 0"><a href="${esc(url)}" style="background:#12703C;color:#fff;text-decoration:none;padding:11px 18px;border-radius:9px;font-weight:700;display:inline-block">${esc(urlText || 'Open')}</a></p>`
      : '';

    const html =
      '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1E1B16">'
      + `<h2 style="margin:0 0 12px;font-size:1.15rem">${esc(heading || subject)}</h2>`
      + `<div style="color:#5A5347;font-size:14px;line-height:1.55">${body}</div>`
      + cta
      + '<p style="color:#9A9284;font-size:12px;margin-top:22px">Killswitch Websites &middot; automatic notification</p>'
      + '</div>';

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: process.env.KS_FROM_EMAIL || FROM_DEFAULT,
        to: [to],
        subject,
        html,
      }),
    });

    if (!r.ok) {
      console.error('[notify] resend', r.status, await r.text().catch(() => ''));
      return { sent: false, reason: 'resend_' + r.status };
    }
    return { sent: true };
  } catch (e) {
    console.error('[notify] error', e);
    return { sent: false, reason: 'threw' };
  }
}

/** Send a transactional update to one known customer. Never rejects. */
export async function notifyCustomer({
  to, subject, heading, lines = [], url, urlText, secondaryUrl, secondaryUrlText, idempotencyKey,
}) {
  try {
    if (!externalSideEffectsAllowed()) return { sent: false, reason: 'preview_side_effects_disabled' };
    const key = process.env.RESEND_API_KEY;
    const recipient = String(to || '').trim().toLowerCase();
    if (!key) { console.error('[notify-customer] skipped, RESEND_API_KEY unset:', subject); return { sent: false, reason: 'no_api_key' }; }
    if (!recipient.includes('@')) return { sent: false, reason: 'invalid_recipient' };

    const body = lines.map((line) => `<p style="margin:0 0 7px">${esc(line)}</p>`).join('');
    const cta = url
      ? `<p style="margin:18px 0 0"><a href="${esc(url)}" style="background:#12703C;color:#fff;text-decoration:none;padding:11px 18px;border-radius:9px;font-weight:700;display:inline-block">${esc(urlText || 'Open')}</a></p>`
      : '';
    const secondaryCta = secondaryUrl
      ? `<p style="margin:12px 0 0"><a href="${esc(secondaryUrl)}" style="color:#12703C;font-weight:700">${esc(secondaryUrlText || 'Learn more')}</a></p>`
      : '';
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1E1B16">'
      + `<h2 style="margin:0 0 12px;font-size:1.15rem">${esc(heading || subject)}</h2>`
      + `<div style="color:#5A5347;font-size:14px;line-height:1.55">${body}</div>${cta}${secondaryCta}`
      + '<p style="color:#9A9284;font-size:12px;margin-top:22px">Killswitch Websites &middot; service update</p></div>';
    const headers = { Authorization: 'Bearer ' + key, 'content-type': 'application/json' };
    if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 256);
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers,
      body: JSON.stringify({ from: process.env.KS_FROM_EMAIL || FROM_DEFAULT, to: [recipient], subject, html }),
    });
    if (!response.ok) {
      console.error('[notify-customer] resend', response.status, await response.text().catch(() => ''));
      return { sent: false, reason: 'resend_' + response.status };
    }
    return { sent: true };
  } catch (e) {
    console.error('[notify-customer] error', e);
    return { sent: false, reason: 'threw' };
  }
}

/** Human label for a module phase, so the email reads like English. */
export const PHASE_LABEL = {
  P1: 'Get Found on Google', P2: 'Content & Email Marketing', P3: 'Online Booking',
  P4: 'Hosting & Maintenance', P5: 'CRM', P6: 'Marketing Automation',
  P7: 'Payments', P8: 'Analytics', P9: '24/7 AI Assistant', P10: 'AI Sales Agent',
  // P11 is billable ($99/mo, in lib/prices.js) and was missing here, so the one
  // notification about the most expensive add-on read "P11" instead of its name.
  P11: 'Care Plan',
};

export function labelPhases(list) {
  return (list || []).map((p) => PHASE_LABEL[p] || p).join(', ');
}
