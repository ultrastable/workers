// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Read-only loops: compare live versions with the deploy ledger (core/deploy reconcile), and count results.
import { first, run, iso } from '../../core/kernel/util.js';
import { cfg, fileItem } from './lib.js';

export async function inventoryLoop({ db, ctx, now, settings }) {
  const s = cfg(settings);
  let ok = 0, drift = 0, err = 0;
  for (const { provider, unit } of s.units) {
    const deploy = s.deploys[provider];
    if (!deploy) continue;
    let r;
    try { r = await deploy.reconcile(unit); } catch (e) { err++; continue; }        // a read error is not drift
    const consistent = r.status !== 'unlogged' ? 1 : 0;
    await run(db, `INSERT OR REPLACE INTO cloud_units (provider, unit, live_version, consistent, detail, checked_at) VALUES (?,?,?,?,?,?)`,
      provider, unit, r.live ?? null, consistent, r.status, iso(now()));
    if (consistent) ok++;
    else {
      drift++;
      await fileItem(db, `CLOUDUNLOGGED-${provider}-${unit}-${r.ledgerId ?? 'x'}`, `${provider}/${unit} changed outside the deploy path (ledger ${r.expected}, live ${r.live})`, `the change to ${unit} is explained in the deploy ledger or reverted through the deploy path`);
    }
  }
  ctx?.notes?.push(`cloud inventory: ${ok} consistent, ${drift} unlogged, ${err} unreadable`);
}

export async function metricsLoop({ db, ctx, now }) {
  const week = iso(now() - 7 * 86400e3);
  const n = async st => (await first(db, `SELECT COUNT(*) AS n FROM cloud_requests WHERE status = ? AND finished_at >= ?`, st, week)).n;
  const row = { deployed: await n('deployed'), reverted: await n('reverted'), failed: await n('failed'),
    unlogged: (await first(db, `SELECT COUNT(*) AS n FROM cloud_units WHERE consistent = 0`)).n };
  await run(db, `INSERT INTO cloud_metrics (at, deployed, reverted, failed, unlogged) VALUES (?,?,?,?,?)`, iso(now()), row.deployed, row.reverted, row.failed, row.unlogged);
  ctx?.notes?.push(`cloud metrics: ${JSON.stringify(row)}`);
}
