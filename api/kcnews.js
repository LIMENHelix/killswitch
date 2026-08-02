// Live Kansas City headlines.
// Server-side fetch of a Google News RSS search for "Kansas City", parsed to JSON
// so the browser has no CORS or third-party-proxy dependency. Cached at the edge
// (s-maxage) so the upstream feed is hit at most once every few minutes.

export default async function handler(req, res) {
  try {
    const feed =
      'https://news.google.com/rss/search?q=' +
      encodeURIComponent('"Kansas City"') +
      '&hl=en-US&gl=US&ceid=US:en';

    const r = await fetch(feed, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Killswitch WebsitesNews/1.0)' },
    });
    const xml = await r.text();

    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRe.exec(xml)) && items.length < 8) {
      const block = m[1];
      const title = decode((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').trim();
      const link = decode((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '').trim();
      const pubDate = ((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '').trim();
      if (title) items.push({ title, link, pubDate });
    }

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    res.status(200).json({ items });
  } catch (e) {
    console.error('[kcnews] error', e);
    res.status(200).json({ items: [] });
  }
}

function decode(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}
