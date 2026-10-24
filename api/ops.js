// Ops console gate. The page itself is static, but it lists every internal
// system, so it is served only to an owner key. Basic auth is deliberate:
// the browser prompts, the key never lands in the URL, and a rep key is
// rejected because isOwner() is the same rule the panels use.
import fs from 'node:fs';
import path from 'node:path';
import { identify, isOwner, anyKeyConfigured } from '../lib/roles.js';

function presentedKey(header) {
  if (!header || !header.startsWith('Basic ')) return '';
  try {
    const raw = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const split = raw.indexOf(':');
    const user = split >= 0 ? raw.slice(0, split) : raw;
    const pass = split >= 0 ? raw.slice(split + 1) : '';
    // Accept the key in the password field (normal) or, for a prompt where
    // someone leaves the password blank, in the username field.
    return pass || user;
  } catch {
    return '';
  }
}

export default function handler(req, res) {
  if (!anyKeyConfigured()) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end('No owner key is configured.');
    return;
  }

  const who = identify(presentedKey(req.headers && req.headers.authorization));
  if (!isOwner(who)) {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', 'Basic realm="Live Local Sites OPS", charset="UTF-8"');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.end('Owner key required.');
    return;
  }

  try {
    const html = fs.readFileSync(path.join(process.cwd(), 'ops.html'), 'utf8');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.end(html);
  } catch {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Ops page unavailable.');
  }
}
