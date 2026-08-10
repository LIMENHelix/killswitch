// Single source of truth for switch -> Stripe monthly price. Read directly from
// the live "Killswitch Websites Domains" Stripe account. checkout.js keeps its own copy
// for the legacy bundle flow; the panel on/off engine uses these.
export const MONTHLY = {
  P1: 'price_1ToXlLPmxnF3rtBM5NRurfkt', // Get Found on Google — $19/mo
  P2: 'price_1ToXlrPmxnF3rtBMz3ybz47E', // Content & Email — $29/mo
  P3: 'price_1ToXlsPmxnF3rtBM9Dc9mDul', // Online Booking — $19/mo
  P4: 'price_1ToXltPmxnF3rtBMvKKaw7vx', // Hosting & Maintenance — $29/mo
  P5: 'price_1ToXluPmxnF3rtBMEleF5u3D', // CRM — $29/mo
  P6: 'price_1ToXlvPmxnF3rtBM7aDkUq1Y', // Marketing Automation — $29/mo
  P7: 'price_1ToXlwPmxnF3rtBMfqIS7WEs', // Payments — $19/mo
  P8: 'price_1ToXlyPmxnF3rtBMendZWgMs', // Analytics — $19/mo
  P9: 'price_1ToXlzPmxnF3rtBMv1DlSFC5', // 24/7 AI Assistant — $29/mo
  P11: 'price_1TnMiMPmxnF3rtBMgqTJpLh6', // Care Plan — $99/mo
};

export const PRICE_TO_PHASE = Object.fromEntries(
  Object.entries(MONTHLY).map(([phase, id]) => [id, phase])
);

// RETIRED: priced in Stripe but NOT FOR SALE, for a module with nothing behind
// it. The gate stays because it is the thing that stops the catalogue drifting
// ahead of the code again, and because retiring is not deleting: a retired id
// stays in MONTHLY and PRICE_TO_PHASE above so anyone who already bought one
// still reads as entitled, still sees it in their panel, and can still switch it
// OFF. Dropping it from the maps would make a live subscription invisible to us
// while Stripe kept charging for it. What a retired id blocks is ADDING one.
//
// EMPTY, and it should stay that way. P5 (CRM) and P6 (Marketing Automation)
// sat here briefly on 2026-08-10 because they were sold with no implementation
// at all. They were built instead of dropped: lib/crm.js keeps every enquiry and
// booking as a person with a history, and lib/automation.js queues the
// acknowledgement and the review request that api/cron-followups.js sends.
// Anything added here again must come with a dated note saying why.
export const RETIRED = new Set();

/** Can a customer start paying for this module today? */
export function isSellable(phase) {
  return !!MONTHLY[phase] && !RETIRED.has(phase);
}
