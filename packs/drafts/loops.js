// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tick-step entries named in pack.json. Class C: no outbound loop; the guard would refuse a send anyway.
import { all, first, run, iso } from '../../core/kernel/util.js';
import { ensureItem } from '../../core/kernel/util.js';

const ROLE = 'pack-manager-drafts', PROJECT = 'pack-drafts';

// A draft untouched for stale_days becomes an item, so it is revised or closed rather than left to rot.
export async function stale({ db, ctx, now, settings = {} }) {
  const days = settings.stale_days ?? 14;
  let n = 0;
  for (const d of await all(db, `SELECT id, title FROM drafts_items WHERE status = 'draft' AND updated_at < ?`, iso(now() - days * 86400e3))) {
    if (await ensureItem(db, { id: `DRAFTSTALE-${d.id}`, title: `Draft ${d.id} "${d.title.slice(0, 60)}" untouched for ${days} days`, owner_role: ROLE,
      done_check: `draft ${d.id} is revised, taken or closed`, priority: 0, project: PROJECT })) n++;
  }
  ctx?.notes?.push(`drafts stale: ${n} new item(s)`);
}

export async function metrics({ db, ctx, now, settings = {} }) {
  const t = now(), days = settings.stale_days ?? 14;
  const n = async (sql, ...a) => (await first(db, sql, ...a)).n;
  const row = {
    open: await n(`SELECT COUNT(*) AS n FROM drafts_items WHERE status = 'draft'`),
    stale: await n(`SELECT COUNT(*) AS n FROM drafts_items WHERE status = 'draft' AND updated_at < ?`, iso(t - days * 86400e3)),
    versions: await n(`SELECT COUNT(*) AS n FROM drafts_versions WHERE created_at >= ?`, iso(t - 7 * 86400e3)),
  };
  await run(db, `INSERT INTO drafts_metrics (at, open_drafts, stale, versions_7d) VALUES (?,?,?,?)`, iso(t), row.open, row.stale, row.versions);
  ctx?.notes?.push(`drafts metrics: ${row.open} open, ${row.stale} stale, ${row.versions} versions in 7 days`);
}
