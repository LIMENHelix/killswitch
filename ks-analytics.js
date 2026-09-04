/* Conversion events and a human filter for Vercel Web Analytics.
 *
 * The dashboard was counting VISITS and nothing else, so it could tell you 56
 * people arrived and nothing about whether any of them did anything. It also
 * could not separate a plumber from a crawler: 18% GNU/Linux desktop and 37%
 * non-US traffic on a site that sells to US local trades is mostly automated.
 *
 * Two additions, both client-side, neither touching any existing form logic:
 *
 * 1. CONVERSION EVENTS. Every form success, every checkout start, every tap on
 *    a phone number. These are inherently human: a crawler does not submit a
 *    form or dial a number. So the event counts ARE the unbotted numbers.
 *
 * 2. human_visit. Vercel offers no bot filter you can configure, and a headless
 *    crawler runs scripts, so a pageview cannot be trusted. This fires once per
 *    page, only after a real interaction signal: a pointer that actually moves,
 *    a touch, a key, a scroll, or four seconds of a visible tab. Compare
 *    human_visit against the visitor count to see how much of the traffic is
 *    real, without changing what the visitor count itself reports.
 *
 * Uses the documented script-tag queue, so it works with the plain
 * /_vercel/insights/script.js already on every page. No package, no build step.
 */
(function () {
  'use strict';

  // The queue shim Vercel's script drains once it loads. Safe to call before it.
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };

  // Keep first-party attribution for this browser session. This is enough to
  // follow a person from a city/trade landing page to signup without creating a
  // long-lived identifier. The server accepts the same allowlisted envelope.
  var ATTR_KEY = 'ks:campaign-attribution';
  var PARAMS = {
    utm_source: 'source', utm_medium: 'medium', utm_campaign: 'campaign',
    utm_content: 'content', utm_term: 'term',
    gclid: 'gclid', msclkid: 'msclkid', fbclid: 'fbclid'
  };

  function clipped(value, max) {
    return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  }

  function captureAttribution() {
    var current = {};
    try { current = JSON.parse(sessionStorage.getItem(ATTR_KEY) || '{}') || {}; } catch (e) {}
    try {
      var query = new URLSearchParams(location.search);
      var hasCampaign = false;
      Object.keys(PARAMS).forEach(function (param) {
        if (!query.has(param)) return;
        hasCampaign = true;
        current[PARAMS[param]] = clipped(query.get(param), param === 'utm_campaign' ? 120 : 180);
      });
      if (hasCampaign || !current.landingPage) {
        current.landingPage = clipped(location.pathname, 180);
        if (document.referrer) current.referrerHost = clipped(new URL(document.referrer).hostname, 120);
      }
      sessionStorage.setItem(ATTR_KEY, JSON.stringify(current));
    } catch (e) { /* private browsing or a malformed referrer must not break the page */ }
    return current;
  }

  var attribution = captureAttribution();
  window.ksAttribution = function () { return Object.assign({}, attribution); };

  function eventAttribution() {
    var out = {};
    if (attribution.source) out.utm_source = attribution.source;
    if (attribution.medium) out.utm_medium = attribution.medium;
    if (attribution.campaign) out.utm_campaign = attribution.campaign;
    if (attribution.landingPage) out.landing = attribution.landingPage;
    return out;
  }

  /**
   * Record a conversion. Never throws: analytics must not be able to break a
   * form submission, which is the whole point of the thing being measured.
   */
  function ksEvent(name, data) {
    try {
      var details = Object.assign(eventAttribution(), data || {});
      window.va('event', { name: name, data: details });
    }
    catch (e) { /* measuring must never cost a lead */ }
  }
  window.ksEvent = ksEvent;

  // ---- 2. is anybody actually there ----
  var fired = false;
  function human(how) {
    if (fired) return;
    fired = true;
    ksEvent('human_visit', { signal: how, path: location.pathname });
    off();
  }

  // A pointer EVENT is not proof; some crawlers synthesise one at 0,0 and never
  // move. Two positions apart is a hand.
  var lastX = null, lastY = null;
  function onMove(e) {
    if (lastX !== null && (Math.abs(e.clientX - lastX) > 2 || Math.abs(e.clientY - lastY) > 2)) human('pointer');
    lastX = e.clientX; lastY = e.clientY;
  }
  function onScroll() { if (window.scrollY > 40) human('scroll'); }
  function onTouch() { human('touch'); }
  function onKey() { human('key'); }

  function off() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('scroll', onScroll);
    document.removeEventListener('touchstart', onTouch);
    document.removeEventListener('keydown', onKey);
  }
  document.addEventListener('mousemove', onMove, { passive: true });
  document.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('touchstart', onTouch, { passive: true });
  document.addEventListener('keydown', onKey, { passive: true });

  // Dwell counts too, but only on a VISIBLE tab. A background prefetch or a
  // link preview should not be able to buy its way to looking like a person.
  var dwell = 0;
  var tick = setInterval(function () {
    if (document.visibilityState === 'visible') dwell += 1;
    if (dwell >= 4) { clearInterval(tick); human('dwell'); }
    if (fired) clearInterval(tick);
  }, 1000);

  // ---- 1. the conversions ----
  // Phone is the main channel for this business, so a tap on a number is the
  // highest-intent thing that happens on the site and was invisible.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href^="tel:"]');
    if (a) { human('call'); ksEvent('call_clicked', { path: location.pathname }); }
  }, { passive: true, capture: true });

  // Measure the handoff points that matter operationally, without recording
  // link text or destination query strings that may contain customer data.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var kind = '';
    if (/calendly\.com/i.test(href)) kind = 'booking';
    else if (/^mailto:/i.test(href)) kind = 'email';
    else if (/^\/(start|pricing)(?:[?#]|$)/i.test(href)) kind = 'site_cta';
    if (kind) ksEvent('cta_clicked', { kind: kind, path: location.pathname });
  }, { passive: true, capture: true });

  // Someone reaching a demo is a warm signal: the only way to one is a postcard,
  // a call, or the homepage proof link.
  if (/^\/demos\//.test(location.pathname)) {
    ksEvent('demo_viewed', { demo: location.pathname.replace('/demos/', '') });
  }
  // A customer's own site at /s/<slug> deliberately does NOT load this file.
  // Their visitors are not Killswitch's visitors, and counting them here would
  // inflate the numbers this whole exercise exists to make trustworthy. Those
  // sites have their own counter (P8) that reports to the customer instead.
})();
