// The one place a self-serve site becomes visible, and why it lives here.
//
// api/inbound.js creates a new signup's site as a hard 404. Nothing exists in
// public for a business name and an address that nobody has proved they own,
// because that is exactly what a script did 117 times.
//
// The proof is opening the panel link mailed to that address. Every entry into
// the panel passes through verifyPanel() in api/switch.js, and the standalone
// account read does the same in api/account.js, so the flip belongs at those two
// points rather than in the signup itself.
//
// It is deliberately narrow. Only a self-serve site still carrying
// `awaitingVerification` moves. A draft the operator built, and a site the owner
// unpublished, both have that flag absent or cleared, so opening a panel never
// resurrects them — that guarantee is older than this file and is tested.
import { siteForEmail, upsertSite } from './sites.js';

/**
 * Claim the site belonging to a verified panel owner, publishing it if it is
 * still a self-serve signup waiting for exactly this.
 * @returns {Promise<object|null>} the site record, or null when they have none
 */
export async function publishOnPanelOpen(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;

  const site = await siteForEmail(e);
  if (!site || !site.slug) return null;
  if (site.claimed) return site; // already theirs; never touch it behind them

  const patch = { slug: site.slug, claimed: true };
  if (site.awaitingVerification) {
    patch.published = true;
    patch.awaitingVerification = false;
    patch.verifiedAt = new Date().toISOString();
  }
  return upsertSite(patch);
}
