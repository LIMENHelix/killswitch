// Local proof renderer for the K6 postcard: writes front/back HTML (with the
// production QR URL rewritten to the local asset) for headless-Chrome
// screenshots. Proof only — no Lob call, no mail piece.
import fs from 'node:fs';
import path from 'node:path';

const m = await import('../../lib/postcard.js');
const lead = { name: 'Proof Auto Repair', trade: 'auto repair' };
const dir = import.meta.dirname;
const localQr = 'file:///' + path.resolve(dir, '../../qr-start.png').replace(/\\/g, '/');
fs.writeFileSync(path.join(dir, '_front.html'), m.frontHtml(lead));
fs.writeFileSync(path.join(dir, '_back.html'), m.backHtml(lead).replace('https://killswitchwebsites.com/qr-start.png', localQr));
console.log('proof html written');
