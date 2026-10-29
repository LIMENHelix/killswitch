// Read a customer's account for their control panel. Auth is the passwordless
// token from their portal link (?e=<email>&t=<token>). It returns only what the
// panel needs to render (never the Stripe customer id). A valid panel token is
// also the signup verification: opening the emailed link marks the site claimed
// so it can be indexed.
//
// GET /api/account?e=<email>&t=<token>  ->  { email, name, site, plan, linked }
import { getAccount } from '../lib/store.js';
import { verifyPanel } from '../lib/panel-auth.js';
import { publishOnPanelOpen } from '../lib/claims.js';

export default async function handler(req, res) {
  const email = String((req.query && req.query.e) || '').trim().toLowerCase();
  const token = String((req.query && req.query.t) || '');

  if (!await verifyPanel(email, token)) { res.status(401).json({ error: 'unauthorized' }); return; }

  let account;
  try { account = await getAccount(email); }
  catch (e) { console.error('[account] store error', e); res.status(500).json({ error: 'store_error' }); return; }
  if (!account) { res.status(404).json({ error: 'not_found' }); return; }

  // A valid panel token means someone with that inbox opened the link. That is
  // the gate a self-serve site clears before it exists in public at all.
  try { await publishOnPanelOpen(email); }
  catch (e) { console.error('[account] publish', e); }

  res.status(200).json({
    email: account.email,
    name: account.name || '',
    site: account.site || '',
    plan: Array.isArray(account.plan) && account.plan.length ? account.plan : ['P0'],
    linked: !!account.stripeCustomerId, // whether a Stripe customer is attached yet
  });
}
