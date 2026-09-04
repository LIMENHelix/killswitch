import { stripeGet } from './stripe.js';
import { PRICE_TO_PHASE } from './prices.js';

const NAME_TO_PHASE = [
  [/online booking|scheduling/i, 'P3'],
  [/crm|customer database/i, 'P5'],
  [/payments?\s*(?:&|and)?\s*checkout|payment gateway/i, 'P7'],
];

function phaseFromText(value) {
  const text = String(value || '');
  for (const [pattern, phase] of NAME_TO_PHASE) if (pattern.test(text)) return phase;
  return '';
}

export async function checkoutPhases(session) {
  const out = new Set();
  const sessionId = String(session && session.id || '');
  let lines = session && session.line_items;
  if (!lines && sessionId) lines = await stripeGet('/checkout/sessions/' + encodeURIComponent(sessionId) + '/line_items?limit=100&expand[]=data.price.product');
  for (const line of (lines && lines.data) || []) {
    const price = line.price || {};
    const direct = PRICE_TO_PHASE[price.id];
    const metadata = price.metadata && (price.metadata.ks_phase || price.metadata.phase);
    const product = price.product || {};
    const inferred = phaseFromText(line.description) || phaseFromText(typeof product === 'object' ? product.name : '');
    const phase = direct || (typeof metadata === 'string' && /^P(?:[1-9]|10|11)$/.test(metadata) ? metadata : '') || inferred;
    if (phase) out.add(phase);
  }
  return [...out];
}
