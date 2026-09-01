// Let a customer choose how their own website looks. FREE, for everyone.
//
// POST /api/theme  { e, t, action }
//   action 'list' (default)  -> { ok, current, themes:[{id,label,note,swatch}] }
//   action 'set'  { theme }  -> { ok, current, siteUrl }
//
// A SEPARATE FUNCTION ON PURPOSE. Everything else the panel does goes through
// api/switch.js, which is the Stripe billing engine: it reconciles subscriptions,
// adds and removes line items and cancels at period end. Picking a colour must
// never be able to reach that code, and a mistake in here must never be able to
// touch anybody's bill. So this file talks to the site record and nothing else.
// It imports no Stripe, no prices, no entitlements.
//
// It also carries NO phase code. A theme is not a module and is not for sale.
// The free site is the thing that earns the right to sell a switch later, and a
// site the owner picked the look of is a site they feel is theirs.
import { verifyPanel } from '../lib/panel-auth.js';
import { getAccount } from '../lib/store.js';
import { siteForEmail, upsertSite } from '../lib/sites.js';
import { THEMES, THEME_NAMES, DEFAULT_THEME, isTheme, themeFor } from '../lib/site-template.js';
import { limited } from '../lib/ratelimit.js';

/** What the panel needs to draw the picker, without shipping the whole theme. */
function catalogue() {
  return THEME_NAMES.map((id) => ({
    id,
    label: THEMES[id].label,
    note: THEMES[id].note,
    // Three colours are enough to draw a recognisable swatch.
    swatch: { bg: THEMES[id].bg, ink: THEMES[id].ink, ac: THEMES[id].ac },
  }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  // Authenticated already, so this is only about stopping a stuck client looping
  // a write onto a site record. Fails OPEN: losing a colour change is a worse
  // outcome than a few extra KV writes, and there is no money on this path.
  if (await limited(req, res, { bucket: 'theme', limit: 30, windowSec: 3600, failClosed: false })) return;

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  const email = String(body.e || '').trim().toLowerCase();
  const token = String(body.t || '');
  if (!await verifyPanel(email, token)) { res.status(401).json({ error: 'unauthorized' }); return; }

  const account = await getAccount(email);
  if (!account) { res.status(404).json({ error: 'not_found' }); return; }

  // THEIR OWN SITE, LOOKED UP FROM THEIR OWN EMAIL. The slug is never taken from
  // the request, so a customer cannot restyle somebody else's website by naming
  // it. This is the same join api/switch.js reads, so it cannot drift from it.
  let rec = null;
  try { rec = await siteForEmail(email); }
  catch (e) { console.error('[theme] site lookup', e); res.status(500).json({ error: 'server_error' }); return; }

  const action = body.action || 'list';

  if (!rec) {
    // NO SITE JOINED YET IS A REAL STATE (see lib/site-link.js, which creates
    // nothing on purpose). There is no record to write a theme onto, so the
    // choice cannot be stored anywhere. This used to answer a 'set' with
    // ok:true and throw the choice away, which is the same lie as a switch that
    // goes green while nothing renders.
    //
    // The preference is NOT parked on the account instead. That would need a
    // new field plus something to consume it at site-creation time, which is
    // new machinery for a state that resolves itself the moment the site
    // exists.
    if (action === 'set') {
      res.status(409).json({
        error: 'no_site_yet',
        message: 'Your website is being put together. You will be able to pick a look as soon as it is up.',
      });
      return;
    }
    res.status(200).json({
      ok: true, current: DEFAULT_THEME, themes: catalogue(),
      noSite: true,
      // Says what is true AND matches the panel, which disables the buttons in
      // this state. The previous wording invited them to pick and then gave
      // them nothing to click.
      message: 'Your website is being put together. You will be able to pick a look as soon as it is up.',
    });
    return;
  }

  // A PAGE WRITTEN FOR THIS BUSINESS IGNORES THE THEME, AND THEY HAVE TO BE TOLD.
  // api/site.js serves site.html verbatim and only falls back to renderSite when
  // it is empty, and lib/site-writer.js is instructed to return a complete
  // document with all CSS inline and no external stylesheets, so a written page
  // carries its own colours and never reads the template's variables. Injecting
  // them would change nothing. api/master.js already carries this same warning
  // about its editor. The theme is still stored, because site-unwrite drops the
  // written page and falls back to the template, at which point it does apply.
  const written = !!(rec.html && rec.html.length);

  if (action === 'list') {
    res.status(200).json({
      ok: true,
      current: isTheme(rec.theme) ? String(rec.theme).toLowerCase() : DEFAULT_THEME,
      themes: catalogue(),
      siteUrl: rec.published ? '/s/' + rec.slug : '',
      written,
      message: written
        ? 'Your site has a page written specially for it, so these looks do not change it. Ask us to switch it back to the standard layout if you want to use them.'
        : '',
    });
    return;
  }

  if (action === 'set') {
    const want = String(body.theme || '').toLowerCase();
    // Refuse anything not on the list rather than storing it. renderSite would
    // fall back to warm anyway, but then the panel would show a saved theme that
    // is not the one on the page, which is worse than an error.
    if (!isTheme(want)) { res.status(400).json({ error: 'unknown_theme', themes: THEME_NAMES }); return; }

    let saved;
    try { saved = await upsertSite({ slug: rec.slug, theme: want }); }
    catch (e) { console.error('[theme] save', rec.slug, e); res.status(500).json({ error: 'server_error' }); return; }

    res.status(200).json({
      ok: true,
      current: saved.theme || DEFAULT_THEME,
      label: themeFor(saved.theme).label,
      // Only a published site gets a link. api/site.js 404s a draft, and sending
      // someone to their own broken link is worse than saying nothing.
      siteUrl: (saved.published && !written) ? '/s/' + saved.slug : '',
      // WHETHER THE PAGE THEY CAN VISIT ACTUALLY CHANGED. ok:true only means the
      // choice was stored. The panel must not say "open it to see it" about a
      // page that looks exactly as it did.
      applied: !written,
      written,
      message: written
        ? 'Saved, but your site has a page written specially for it, so it still looks the same. Ask us to switch it back to the standard layout to use these.'
        : '',
    });
    return;
  }

  res.status(400).json({ error: 'unknown_action' });
}
