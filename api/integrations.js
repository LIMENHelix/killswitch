// Customer-owned connection center.
//
// POST /api/integrations { e, t, action:'list' }
// POST /api/integrations { e, t, action:'set', field, value }
//
// Only the signed panel link can reach this endpoint, and the site is always
// resolved from that email. A request cannot name another customer's slug.
import { verifyPanel } from '../lib/panel-auth.js';
import { getAccount } from '../lib/store.js';
import { siteForEmail, upsertSite } from '../lib/sites.js';
import { limited } from '../lib/ratelimit.js';
import { integrationCatalogue, INTEGRATIONS, validateIntegration } from '../lib/integrations.js';
import { recordLifecycle, reconcileLifecycle } from '../lib/lifecycle.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  if (await limited(req, res, { bucket: 'integrations', limit: 30, windowSec: 3600, failClosed: false })) return;

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  const email = String(body.e || '').trim().toLowerCase();
  const token = String(body.t || '');
  if (!await verifyPanel(email, token)) { res.status(401).json({ error: 'unauthorized' }); return; }

  const account = await getAccount(email);
  if (!account) { res.status(404).json({ error: 'not_found' }); return; }

  let site;
  try { site = await siteForEmail(email); }
  catch (e) { console.error('[integrations] site lookup', e); res.status(500).json({ error: 'server_error' }); return; }
  if (!site) { res.status(409).json({ error: 'no_site_yet' }); return; }

  const action = body.action || 'list';
  if (action === 'list') {
    res.status(200).json({ ok: true, integrations: integrationCatalogue(site) });
    return;
  }

  if (action !== 'set') { res.status(400).json({ error: 'unknown_action' }); return; }
  const field = String(body.field || '');
  if (!Object.prototype.hasOwnProperty.call(INTEGRATIONS, field)) {
    res.status(400).json({ error: 'unknown_integration' }); return;
  }
  const def = INTEGRATIONS[field];
  if (!(site.modules || []).includes(def.phase)) {
    res.status(403).json({ error: 'not_entitled', phase: def.phase });
    return;
  }

  const checked = validateIntegration(field, body.value);
  if (checked.error) { res.status(400).json({ error: checked.error }); return; }

  try {
    const saved = await upsertSite({ slug: site.slug, [field]: checked.value });
    await recordLifecycle(email, {
      type: checked.value ? 'integration.connected' : 'integration.disconnected',
      idempotencyKey: 'panel-integration:' + field + ':' + checked.value,
      data: { field, phase: def.phase, provider: checked.provider || '' },
    });
    await reconcileLifecycle({
      email, account, site: saved, phases: saved.modules,
      idempotencyKey: 'panel-integrations:' + (saved.googleBusinessProfile || '') + ':' + (saved.bookingUrl || '') + ':' + (saved.payUrl || ''),
    });
    res.status(200).json({
      ok: true,
      field,
      connected: !!checked.value,
      value: checked.value,
      provider: checked.provider || '',
      integrations: integrationCatalogue(saved),
      siteUrl: saved.published ? '/s/' + saved.slug : '',
    });
  } catch (e) {
    console.error('[integrations] save', email, field, e);
    res.status(500).json({ error: 'server_error' });
  }
}
