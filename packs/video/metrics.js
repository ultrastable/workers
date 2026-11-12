// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Counts, removal detection and view read-back for the pack manager.
import { all, first, run, iso } from '../../core/kernel/util.js';
import { cfg, fileItem } from './lib.js';

export async function metricsLoop({ db, ctx, now, settings, guard }) {
  const s = cfg(settings), channel = s.ports.channel, t = now();
  if (channel) {
    for (const r of await all(db, `SELECT * FROM video_queue WHERE status = 'published' AND verify_status = 'verified' AND published_at > ?`, iso(t - 7 * 86400e3))) {
      let v; try { v = await channel.fetchVideo(r.provider_id); } catch { continue; }       // a read error is not a removal
      if (!v) {
        await run(db, `UPDATE video_queue SET status = 'removed', removed_at = ? WHERE id = ?`, iso(t), r.id);
        await fileItem(db, `VIDEOREMOVED-${r.id}`, `Video ${r.id} is no longer on the channel`, `the reason video ${r.id} disappeared is recorded`);
      } else if (Number.isFinite(v.views)) await run(db, `UPDATE video_queue SET views = ?, views_at = ? WHERE id = ?`, v.views, iso(t), r.id);
    }
  }
  const week = iso(t - 7 * 86400e3);
  const n = async where => (await first(db, `SELECT COUNT(*) AS n FROM video_queue WHERE ${where}`, week)).n;
  const stats = guard ? await guard.stats() : {};
  const row = {
    published: await n(`status IN ('published','removed') AND published_at > ?`), verified: await n(`status = 'published' AND verify_status = 'verified' AND published_at > ?`),
    removed: await n(`status = 'removed' AND removed_at > ?`), refused: stats.refused || 0,
    views: (await first(db, `SELECT COALESCE(SUM(views),0) AS n FROM video_queue WHERE published_at > ?`, week)).n,
  };
  await run(db, `INSERT INTO video_metrics (at, published, verified, removed, refused, views) VALUES (?,?,?,?,?,?)`, iso(t), row.published, row.verified, row.removed, row.refused, row.views);
  ctx?.notes?.push(`video metrics: ${JSON.stringify(row)}`);
}
