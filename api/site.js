// Serves EVERY customer website from one function.
//
// GET /s/<slug>  (rewritten to /api/site?slug=<slug> in vercel.json)
//
// One route, unlimited customers. This is the point: a template change upgrades
// every customer at once, and Vercel's function count does not grow with sales.
import { getSite } from '../lib/sites.js';
import { renderSite } from '../lib/site-template.js';
import { enforceRobots } from '../lib/site-writer.js';
import { recordShow } from '../lib/funnel.js';

export default async function handler(req, res) {
  const slug = String((req.query && req.query.slug) || '').trim();
  if (!slug) { res.status(400).send('missing slug'); return; }

  let site;
  try {
    site = await getSite(slug);
  } catch (e) {
    console.error('[site] store', e);
    res.status(500).send('temporarily unavailable');
    return;
  }

  // Unpublished is deliberately a 404, not a preview: a half-built site must
  // never be reachable by guessing the URL, and must never be indexed.
  if (!site || !site.published) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.status(404).send('<!DOCTYPE html><meta charset="utf-8"><title>Not found</title><meta name="robots" content="noindex"><body style="font-family:system-ui;padding:40px;color:#1E1B16;background:#F6F1E7"><h1>Not found</h1><p>No site here yet.</p></body>');
    return;
  }

  const host = (req.headers && req.headers.host) ? 'https://' + req.headers.host : 'https://killswitchwebsites.com';

  // A site written for THIS business wins. The shared template is the fallback,
  // so a business whose own page has not been written yet still has one.
  // enforceRobots re-applies the index rule on every serve rather than trusting
  // what was stored, so claiming or unclaiming a site takes effect immediately.
  let html;
  if (site.html) {
    try {
      html = enforceRobots(site.html, !!site.claimed);
    } catch (e) {
      console.error('[site] stored html', slug, e);
      html = '';
    }
  }
  if (!html) {
    try {
      html = renderSite(site, { base: host });
    } catch (e) {
      console.error('[site] render', slug, e);
      res.status(500).send('temporarily unavailable');
      return;
    }
  }

  // A SHOW, observed rather than clicked. They opened the site we built them,
  // which is the appointments>shows transition actually happening. Fire and
  // forget: a funnel write must never delay or break serving their page.
  if (site.leadId) {
    recordShow(site.leadId).catch((e) => console.error('[site] recordShow', e));
  }

  res.setHeader('content-type', 'text/html; charset=utf-8');
  // Short cache: edits from the panel should show up quickly, but a burst of
  // traffic to one site must not hammer Redis on every hit.
  res.setHeader('cache-control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  res.status(200).send(html);
}
