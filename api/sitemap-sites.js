// A sitemap of the customer sites we host.
//
// Part of what P1 is now sold as ("listed in our sitemap so Google finds it"),
// and it did not exist: the static sitemap.xml has 217 marketing URLs and not a
// single /s/ entry, so no customer site was ever submitted to anyone.
//
// ONLY CLAIMED SITES GO IN, which is the same rule the template applies when it
// decides whether to emit a noindex tag. A published-but-unclaimed site is a
// draft built for a business that has agreed to nothing yet, reachable by its
// link so a postcard or a phone call can point at it, and deliberately kept out
// of the index. Submitting one here would ask Google to index a page carrying a
// real company's name, address and phone without their say-so, which is the one
// thing the three publish states exist to prevent.
//
// Generated per request rather than written to disk, because the set changes
// whenever anyone is onboarded and a stale file is worse than none.
import { listSites } from '../lib/sites.js';

export default async function handler(req, res) {
  const host = (req.headers && req.headers.host) ? 'https://' + req.headers.host : 'https://killswitchwebsites.com';

  let sites = [];
  try {
    sites = await listSites();
  } catch (e) {
    console.error('[sitemap-sites] list', e);
    // An empty but VALID sitemap beats a 500. A crawler that gets an error may
    // back off from re-requesting for a long time.
    sites = [];
  }

  const live = sites.filter((s) => s && s.slug && s.published && s.claimed);

  const body = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + live.map((s) => `  <url><loc>${host}/s/${xml(s.slug)}</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`).join('\n')
    + (live.length ? '\n' : '')
    + '</urlset>\n';

  res.setHeader('content-type', 'application/xml; charset=utf-8');
  // An hour is plenty: a new customer site does not need to be submitted within
  // seconds, and this reads the whole index.
  res.setHeader('cache-control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
  res.status(200).send(body);
}

function xml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
