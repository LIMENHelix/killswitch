// The P4 maintenance job: a daily backup and an uptime sweep.
// PURELY ADDITIVE. It reads, snapshots and reports. It changes no site, no
// account and no subscription, so the worst a bug here can do is a noisy email.
//
// FAILS CLOSED on CRON_SECRET, same pattern as the other two crons, because an
// open endpoint that walks every customer site is a free denial-of-service lever.
import { runBackup, checkUptime, lastUptime, sweepExpired } from '../lib/backup.js';
import { listSites } from '../lib/sites.js';
import { getAccounts, saveAccounts } from '../lib/store.js';
import { notifyOperator, labelPhases } from '../lib/notify.js';
// The loud version, so a module that expires against a customer with no site
// record reports itself instead of returning null into the sweep's tally and
// being counted as done. See lib/site-link.js.
import { removeModulesLoud } from '../lib/site-link.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const allowed = (req.headers && req.headers.authorization === 'Bearer ' + secret)
    || (req.query && (req.query.token === process.env.ADMIN_KEY || req.query.token === process.env.SWITCH_TOKEN));
  if (!secret || !allowed) { res.status(401).json({ error: 'unauthorized' }); return; }

  const out = { backup: null, uptime: null, expired: null, errors: [] };

  // FIRST, because it is the only thing that actually ends a paid module. A
  // customer switched something off, kept it for the cycle they paid for, and
  // this is the day it stops.
  try {
    out.expired = await sweepExpired({
      getAccounts,
      saveAccounts,
      removeModules: (email, phases) => removeModulesLoud(email, phases, 'paid-cycle-ended'),
    });
    for (const e of out.expired.expired) {
      await notifyOperator({
        subject: `Module ended - ${e.email}`,
        heading: 'A switched-off module reached the end of its paid cycle',
        lines: [`Customer: ${e.email}`, `Now off: ${labelPhases(e.phases)}`,
          'They switched this off earlier and kept it until the cycle they had paid for ran out.'],
        url: 'https://killswitchwebsites.com/master', urlText: 'Open Master Panel',
      });
    }
  } catch (e) {
    console.error('[cron-maintenance] sweep', e);
    out.errors.push('sweep');
  }

  try {
    out.backup = await runBackup();
  } catch (e) {
    console.error('[cron-maintenance] backup', e);
    out.errors.push('backup');
    // A backup that silently stops running is the classic way to discover, at
    // the worst possible moment, that there are no backups.
    await notifyOperator({
      subject: 'BACKUP FAILED',
      heading: 'The daily backup did not run',
      lines: ['Customer sites were not snapshotted today.', String(e && e.message || e).slice(0, 300)],
      url: 'https://killswitchwebsites.com/master', urlText: 'Open Master Panel',
    });
  }

  try {
    const host = (req.headers && req.headers.host) ? 'https://' + req.headers.host : 'https://killswitchwebsites.com';
    const sites = (await listSites()).filter((s) => s && s.published && s.slug);
    const before = await lastUptime();
    out.uptime = await checkUptime(host, sites);

    // Only shout on a CHANGE. A site that was already down and still is does not
    // need a second email every hour; that is how alerts get ignored.
    const wasDown = new Set(((before && before.failures) || []).map((f) => f.slug));
    const fresh = out.uptime.failures.filter((f) => !wasDown.has(f.slug));
    if (fresh.length) {
      await notifyOperator({
        subject: `SITE DOWN - ${fresh.length} customer site${fresh.length === 1 ? '' : 's'}`,
        heading: 'A customer site stopped answering',
        lines: [
          ...fresh.map((f) => `${f.business} (/s/${f.slug}) returned ${f.status || 'no response'}`),
          '',
          `Checked ${out.uptime.checked} published sites.`,
        ],
        url: 'https://killswitchwebsites.com/master', urlText: 'Open Master Panel',
      });
    }
    const recovered = ((before && before.failures) || []).filter(
      (f) => !out.uptime.failures.some((g) => g.slug === f.slug),
    );
    if (recovered.length) {
      await notifyOperator({
        subject: `Back up - ${recovered.length} site${recovered.length === 1 ? '' : 's'} recovered`,
        heading: 'A site that was down is answering again',
        lines: recovered.map((f) => `${f.business} (/s/${f.slug})`),
      });
    }
  } catch (e) {
    console.error('[cron-maintenance] uptime', e);
    out.errors.push('uptime');
  }

  res.status(200).json({ ok: out.errors.length === 0, ...out });
}
