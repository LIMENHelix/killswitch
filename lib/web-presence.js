// What a business's "website" actually is.
//
// The finders used to treat websiteUri as a yes/no and skip anything that had
// one. That discarded the best leads in the list: the operator's own verified
// strike list ranked Auto Tech Services Center #1 ("NAPA AutoCare directory page
// only") and Autobots Garage #2 ("Facebook page is their entire web presence"),
// and both carry a websiteUri. They were found by hand because the code would
// never have surfaced them.
//
// A placeholder is a better lead than nothing at all. The business has already
// decided it wants to be findable and has tried; the pitch is specific and true
// ("your website is a Yelp page") instead of generic ("you have no website").
//
// The vocabulary here is the operator's own, lifted from the web_status column
// of _outreach/kc-verified-strike-list.csv.

/** host suffix -> { status, label } */
const HOSTS = [
  // Social-only presences
  ['facebook.com', 'facebook_only', 'a Facebook page'],
  ['fb.com', 'facebook_only', 'a Facebook page'],
  ['instagram.com', 'facebook_only', 'an Instagram page'],
  ['linktr.ee', 'facebook_only', 'a Linktree'],
  ['nextdoor.com', 'facebook_only', 'a Nextdoor page'],

  // Directory listings, not a site they own
  ['yelp.com', 'directory_only', 'a Yelp page'],
  ['yellowpages.com', 'directory_only', 'a Yellow Pages listing'],
  ['bbb.org', 'directory_only', 'a BBB listing'],
  ['angi.com', 'directory_only', 'an Angi listing'],
  ['angieslist.com', 'directory_only', 'an Angi listing'],
  ['thumbtack.com', 'directory_only', 'a Thumbtack listing'],
  ['houzz.com', 'directory_only', 'a Houzz listing'],
  ['napaautocare.com', 'directory_only', 'a NAPA directory page'],
  ['tripadvisor.com', 'directory_only', 'a TripAdvisor listing'],
  ['doordash.com', 'directory_only', 'a DoorDash page'],
  ['grubhub.com', 'directory_only', 'a Grubhub page'],
  ['booksy.com', 'directory_only', 'a Booksy page'],
  ['vagaro.com', 'directory_only', 'a Vagaro page'],
  ['square.site', 'directory_only', 'a Square page'],
  ['squareup.com', 'directory_only', 'a Square page'],

  // A site they built themselves on a hosted builder. THIS is the one worth
  // fetching: it is their own public page, not a directory's, and it usually
  // carries the email address nobody else will give us.
  ['wixsite.com', 'diy_builder', 'a Wix site'],
  ['wix.com', 'diy_builder', 'a Wix site'],
  ['weebly.com', 'diy_builder', 'a Weebly site'],
  ['godaddysites.com', 'diy_builder', 'a GoDaddy site'],
  ['business.site', 'diy_builder', 'a Google Business site'],
  ['sites.google.com', 'diy_builder', 'a Google Sites page'],
  ['squarespace.com', 'diy_builder', 'a Squarespace site'],
  ['myshopify.com', 'diy_builder', 'a Shopify storefront'],
  ['wordpress.com', 'diy_builder', 'a WordPress.com site'],
  ['blogspot.com', 'diy_builder', 'a Blogspot page'],
  ['webs.com', 'diy_builder', 'a Webs.com site'],
  ['site123.me', 'diy_builder', 'a Site123 page'],
  ['strikingly.com', 'diy_builder', 'a Strikingly page'],
];

/** These are worth building for. `has_site` is not. */
export const TARGET_STATUSES = ['none', 'facebook_only', 'directory_only', 'diy_builder'];

/** Only a site they own on their own machine is safe to fetch for content. */
export const FETCHABLE = ['diy_builder'];

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

/**
 * @param {string} websiteUri whatever Places returned, possibly empty
 * @returns {{status:string, label:string, host:string, url:string, isTarget:boolean}}
 *   status: none | facebook_only | directory_only | diy_builder | has_site
 */
export function classify(websiteUri) {
  const url = String(websiteUri || '').trim();
  if (!url) return { status: 'none', label: 'no website at all', host: '', url: '', isTarget: true };

  const host = hostOf(url);
  if (!host) return { status: 'none', label: 'no website at all', host: '', url: '', isTarget: true };

  for (const [suffix, status, label] of HOSTS) {
    if (host === suffix || host.endsWith('.' + suffix)) {
      return { status, label, host, url, isTarget: true };
    }
  }
  return { status: 'has_site', label: 'their own website', host, url, isTarget: false };
}

/**
 * The one true sentence to open a call or a postcard with. Not a claim about
 * quality, just what is publicly the case.
 */
export function hookLine(lead) {
  const c = classify(lead && lead.web_url);
  const rating = Number(lead && lead.rating) || 0;
  const count = Number(lead && lead.reviews_count) || 0;
  const rep = (rating >= 4 && count >= 15)
    ? `${rating} stars from ${count} reviews`
    : '';
  if (c.status === 'none') {
    return rep ? `${rep}, and no website at all` : 'no website at all';
  }
  return rep ? `${rep}, and your whole website is ${c.label}` : `your whole website is ${c.label}`;
}
