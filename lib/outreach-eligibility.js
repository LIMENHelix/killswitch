// K6 — authoritative prospect-contact eligibility.
//
// Every autonomous outbound provider action must re-derive CURRENT eligibility
// immediately before the effect reservation/provider call. Eligibility is never
// inherited from discovery, drafting, or queue creation.
//
// Rules are conservative: any existing paid/current customer, claimed/customer-
// owned site, suppression, or ambiguous identity → reject.

import { getSuppressionState, matchSuppression } from './suppression.js';
import { getAccounts } from './store.js';
import { listSites } from './sites.js';
import { classify } from './web-presence.js';

const clean = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);
const norm = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]/g, '');
const normPhone = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-10) : '';
};
const normEmail = (v) => String(v || '').trim().toLowerCase();

function compactAddress({ street, city, state, zip }) {
  const parts = [street, city, state, zip].map(clean).filter(Boolean);
  return parts.join('|').toLowerCase().replace(/[^a-z0-9|]/g, '');
}

function isPaidAccount(a) {
  if (!a) return false;
  if (a.stripeCustomerId) return true;
  if (Array.isArray(a.owned) && a.owned.length) return true;
  if (Array.isArray(a.plan) && a.plan.some((p) => p && p !== 'P0')) return true;
  return false;
}

function isCurrentAccount(a) {
  if (!a) return false;
  if (Array.isArray(a.plan) && a.plan.length) return true;
  return false;
}

function isPaidOrClaimedSite(s) {
  if (!s) return false;
  if (s.claimed) return true;
  if (Array.isArray(s.modules) && s.modules.some((m) => m && m !== 'P0')) return true;
  return false;
}

/**
 * Check whether a prospect identity may be contacted on a given channel.
 *
 * identity may include: placeId, id, name, business, city, state, street, zip,
 * phone, email, website, webStatus.
 *
 * If state caches are not passed, current durable state is fetched fresh.
 *
 * Returns a structured result safe to persist in the audit ledger.
 */
export async function checkProspectEligibility(identity, options = {}) {
  const {
    channel = 'unknown',
    suppressionState: suppressionStateInput,
    accountList: accountListInput,
    siteList: siteListInput,
    siteEmailMap: siteEmailMapInput,
  } = options;

  const placeId = clean(identity && identity.placeId);
  const id = clean(identity && identity.id);
  const name = clean(identity && (identity.business || identity.name));
  const city = clean(identity && identity.city);
  const state = clean(identity && identity.state);
  const street = clean(identity && identity.street);
  const zip = clean(identity && identity.zip);
  const phone = normPhone(identity && identity.phone);
  const email = normEmail(identity && identity.email);
  const website = clean(identity && identity.website);
  const webStatus = identity && identity.webStatus;

  const canonicalId = placeId || id || email || phone || compactAddress({ street, city, state, zip }) || norm(name + city);

  const [suppressionState, accountList, siteList, siteEmailMap] = await Promise.all([
    suppressionStateInput || getSuppressionState(),
    accountListInput || getAccounts(),
    siteListInput || listSites(),
    siteEmailMapInput || (async () => {
      const map = {};
      const slugs = await import('./sites.js').then((m) => m.siteSlugsByEmail());
      for (const [e, slug] of Object.entries(slugs || {})) map[e] = slug;
      return map;
    })(),
  ]);

  const matched = [];
  const excluded = [];

  // 1. Suppression
  const contact = { id, name, email, phone, street, city, state, zip };
  const suppressed = matchSuppression(contact, suppressionState || {});
  if (suppressed) {
    excluded.push('suppressed');
    return {
      eligible: false,
      reason: 'suppressed',
      detail: 'do-not-contact record matched',
      canonicalId,
      channel,
      matchedSignals: matched,
      excludedSignals: excluded,
      checkedAt: new Date().toISOString(),
    };
  }

  // 2. Exact name + city against sites
  const cn = norm(name);
  const cc = norm(city);
  let nameCityHits = [];
  if (cn && cc) {
    nameCityHits = (siteList || []).filter((s) => norm(s.business) === cn && norm(s.city) === cc);
    if (nameCityHits.length > 1) {
      excluded.push('ambiguous_identity');
      return {
        eligible: false,
        reason: 'ambiguous_identity',
        detail: 'multiple existing sites share this name and city',
        canonicalId,
        channel,
        matchedSignals: [...matched, 'name_city'],
        excludedSignals: excluded,
        checkedAt: new Date().toISOString(),
      };
    }
    if (nameCityHits.length === 1) {
      matched.push('name_city');
      const s = nameCityHits[0];
      if (s.claimed) {
        excluded.push('claimed_site');
        return {
          eligible: false,
          reason: 'claimed_site',
          detail: 'a claimed customer site already exists',
          canonicalId,
          channel,
          matchedSignals: matched,
          excludedSignals: excluded,
          checkedAt: new Date().toISOString(),
        };
      }
      if (isPaidOrClaimedSite(s)) {
        excluded.push('paid_site');
        return {
          eligible: false,
          reason: 'paid_site',
          detail: 'an existing site has paid modules',
          canonicalId,
          channel,
          matchedSignals: matched,
          excludedSignals: excluded,
          checkedAt: new Date().toISOString(),
        };
      }
    }
  }

  // 3. Phone reconciliation against sites and accounts
  let phoneSiteHits = [];
  let phoneAccountHits = [];
  if (phone) {
    phoneSiteHits = (siteList || []).filter((s) => normPhone(s.phone) === phone);
    phoneAccountHits = Object.values(accountList || {}).filter((a) => normPhone(a && a.phone) === phone);
    const allPhoneHits = phoneSiteHits.concat(phoneAccountHits);
    if (allPhoneHits.length > 1) {
      excluded.push('ambiguous_identity');
      return {
        eligible: false,
        reason: 'ambiguous_identity',
        detail: 'phone matches multiple records',
        canonicalId,
        channel,
        matchedSignals: [...matched, 'phone'],
        excludedSignals: excluded,
        checkedAt: new Date().toISOString(),
      };
    }
    if (phoneSiteHits.length === 1) {
      matched.push('phone');
      const s = phoneSiteHits[0];
      if (s.claimed) {
        excluded.push('claimed_site');
        return {
          eligible: false,
          reason: 'claimed_site',
          detail: 'phone matches a claimed customer site',
          canonicalId,
          channel,
          matchedSignals: matched,
          excludedSignals: excluded,
          checkedAt: new Date().toISOString(),
        };
      }
      if (isPaidOrClaimedSite(s)) {
        excluded.push('paid_site');
        return {
          eligible: false,
          reason: 'paid_site',
          detail: 'phone matches a site with paid modules',
          canonicalId,
          channel,
          matchedSignals: matched,
          excludedSignals: excluded,
          checkedAt: new Date().toISOString(),
        };
      }
    }
    if (phoneAccountHits.length === 1) {
      matched.push('phone');
      const a = phoneAccountHits[0];
      if (isPaidAccount(a)) {
        excluded.push('paid_customer');
        return {
          eligible: false,
          reason: 'paid_customer',
          detail: 'phone matches a paid customer account',
          canonicalId,
          channel,
          matchedSignals: matched,
          excludedSignals: excluded,
          checkedAt: new Date().toISOString(),
        };
      }
      if (isCurrentAccount(a)) {
        excluded.push('current_customer');
        return {
          eligible: false,
          reason: 'current_customer',
          detail: 'phone matches an existing account',
          canonicalId,
          channel,
          matchedSignals: matched,
          excludedSignals: excluded,
          checkedAt: new Date().toISOString(),
        };
      }
    }
  }

  // 4. Email reconciliation against accounts and customer-owned sites
  if (email) {
    const accountByEmail = accountList && accountList[email];
    const siteSlugByEmail = siteEmailMap && siteEmailMap[email];
    const emailMatches = [];
    if (accountByEmail) emailMatches.push({ type: 'account', record: accountByEmail });
    if (siteSlugByEmail) {
      const s = (siteList || []).find((x) => x.slug === siteSlugByEmail);
      if (s) emailMatches.push({ type: 'site', record: s });
    }
    if (emailMatches.length > 1) {
      excluded.push('ambiguous_identity');
      return {
        eligible: false,
        reason: 'ambiguous_identity',
        detail: 'email matches multiple records',
        canonicalId,
        channel,
        matchedSignals: [...matched, 'email'],
        excludedSignals: excluded,
        checkedAt: new Date().toISOString(),
      };
    }
    if (emailMatches.length === 1) {
      matched.push('email');
      const hit = emailMatches[0];
      if (hit.type === 'account') {
        if (isPaidAccount(hit.record)) {
          excluded.push('paid_customer');
          return {
            eligible: false,
            reason: 'paid_customer',
            detail: 'email matches a paid customer account',
            canonicalId,
            channel,
            matchedSignals: matched,
            excludedSignals: excluded,
            checkedAt: new Date().toISOString(),
          };
        }
        if (isCurrentAccount(hit.record)) {
          excluded.push('current_customer');
          return {
            eligible: false,
            reason: 'current_customer',
            detail: 'email matches an existing account',
            canonicalId,
            channel,
            matchedSignals: matched,
            excludedSignals: excluded,
            checkedAt: new Date().toISOString(),
          };
        }
      } else if (hit.type === 'site') {
        if (hit.record.claimed) {
          excluded.push('claimed_site');
          return {
            eligible: false,
            reason: 'claimed_site',
            detail: 'email matches a claimed customer site',
            canonicalId,
            channel,
            matchedSignals: matched,
            excludedSignals: excluded,
            checkedAt: new Date().toISOString(),
          };
        }
        if (isPaidOrClaimedSite(hit.record)) {
          excluded.push('paid_site');
          return {
            eligible: false,
            reason: 'paid_site',
            detail: 'email matches a site with paid modules',
            canonicalId,
            channel,
            matchedSignals: matched,
            excludedSignals: excluded,
            checkedAt: new Date().toISOString(),
          };
        }
      }
    }
  }

  // 5. Domain / website presence
  if (website || webStatus) {
    const status = webStatus || classify(website).status;
    if (status === 'has_site') {
      excluded.push('has_site');
      return {
        eligible: false,
        reason: 'has_site',
        detail: 'business has its own website',
        canonicalId,
        channel,
        matchedSignals: [...matched, 'domain'],
        excludedSignals: excluded,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  // 6. Postal-address reconciliation via suppression fingerprints
  const addr = compactAddress({ street, city, state, zip });
  if (addr) {
    const addrSuppressed = matchSuppression({ street, city, state, zip }, suppressionState || {});
    if (addrSuppressed) {
      excluded.push('suppressed_address');
      return {
        eligible: false,
        reason: 'suppressed',
        detail: 'postal address matches a suppression record',
        canonicalId,
        channel,
        matchedSignals: matched,
        excludedSignals: excluded,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  return {
    eligible: true,
    reason: 'eligible',
    detail: 'no exclusion signal matched',
    canonicalId,
    channel,
    matchedSignals: matched,
    excludedSignals: excluded,
    checkedAt: new Date().toISOString(),
  };
}
