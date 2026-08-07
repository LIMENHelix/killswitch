// One Upstash Redis (Vercel KV) client, shared. store.js and sites.js each had
// their own copy of this, including their own reading of the env vars, which is
// how they ended up with different capabilities.
//
// Env: KV_REST_API_URL/TOKEN (Vercel KV) or UPSTASH_REDIS_REST_URL/TOKEN.

const URL_BASE = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export function configured() { return !!(URL_BASE && TOKEN); }

async function post(path, body) {
  const r = await fetch(URL_BASE + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('kv ' + r.status + ': ' + JSON.stringify(j).slice(0, 160));
  return j;
}

/** One command: cmd(['GET', 'key']) */
export async function cmd(args) {
  return (await post('', args)).result;
}

/**
 * Many commands, one HTTP round trip. Bulk work is thousands of writes and one
 * request each would be thousands of round trips.
 * Falls back to sequential if the pipeline endpoint is unavailable, so this can
 * never be the reason a write does not happen.
 */
export async function pipeline(cmds) {
  if (!cmds || !cmds.length) return [];
  try {
    const out = await post('/pipeline', cmds);
    return Array.isArray(out) ? out.map((x) => (x && Object.prototype.hasOwnProperty.call(x, 'result') ? x.result : x)) : [];
  } catch (e) {
    console.error('[kv] pipeline unavailable, falling back to sequential:', e.message);
    const out = [];
    for (const c of cmds) out.push(await cmd(c));
    return out;
  }
}

/** Upstash returns HGETALL as a flat [field, value, ...] array. Parse JSON values. */
export function parseHash(v) {
  const out = {};
  if (!v) return out;
  if (Array.isArray(v)) {
    for (let i = 0; i + 1 < v.length; i += 2) {
      try { out[v[i]] = JSON.parse(v[i + 1]); } catch { out[v[i]] = v[i + 1]; }
    }
    return out;
  }
  for (const [k, val] of Object.entries(v)) {
    try { out[k] = typeof val === 'string' ? JSON.parse(val) : val; } catch { out[k] = val; }
  }
  return out;
}
