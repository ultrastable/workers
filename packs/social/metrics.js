// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Loop 5: counts, removal detection, engagement read-back, and scoring of the engagement predictions made at queue time.
import { all, first, run, iso } from '../../core/kernel/util.js';
import { cfg, fileItem } from './lib.js';

export async function metricsLoop({ db, ctx, now, settings, guard }) {
  const s = cfg(settings);
  const channel = s.ports.channel;
  const t = now();
  if (channel) {
    for (const r of await all(db, `SELECT * FROM social_queue WHERE status = 'published' AND verify_status = 'verified' AND published_at > ?`, iso(t - 7 * 86400e3))) {
      let post;
      try { post = await channel.fetchPost(r.provider_id); } catch { continue; }          // a read error is not a removal
      if (!post) {
        await run(db, `UPDATE social_queue SET status = 'removed', removed_at = ? WHERE id = ?`, iso(t), r.id);
        await fileItem(db, `SOCIALREMOVED-${r.id}`, `Social post ${r.id} is no longer on the channel`, `the reason post ${r.id} disappeared is recorded and any claim behind it re-checked`);
      } else if (post.metrics) {
        const m = post.metrics, total = (m.likes || 0) + (m.reposts || 0) + (m.replies || 0) + (m.quotes || 0);
        await run(db, `UPDATE social_queue SET engagement = ?, engagement_at = ? WHERE id = ?`, total, iso(t), r.id);
      }
    }
  }
  // Score predictions once a post has had score_after_hours to collect engagement.
  for (const r of await all(db, `SELECT * FROM social_queue WHERE status = 'published' AND engagement IS NOT NULL AND engagement_verdict IS NULL AND published_at <= ?`, iso(t - s.score_after_hours * 3600e3))) {
    const verdict = r.engagement >= r.predicted_engagement ? 'hit' : 'miss';
    await run(db, `UPDATE social_queue SET engagement_verdict = ? WHERE id = ?`, verdict, r.id);
    await run(db, `UPDATE predictions SET observed = ?, verdict = ? WHERE id = ?`, r.engagement, verdict, `social-engagement-${r.id}`);
  }
  const week = iso(t - 7 * 86400e3);
  const n = async where => (await first(db, `SELECT COUNT(*) AS n FROM social_queue WHERE ${where}`, week)).n;
  const stats = guard ? await guard.stats() : {};
  const eng = (await first(db, `SELECT COALESCE(SUM(engagement),0) AS n FROM social_queue WHERE published_at > ?`, week)).n;
  const row = {
    published: await n(`status IN ('published','removed') AND published_at > ?`), verified: await n(`verify_status = 'verified' AND status = 'published' AND published_at > ?`),
    removed: await n(`status = 'removed' AND removed_at > ?`), refused: stats.refused || 0, engagement: eng,
  };
  await run(db, `INSERT INTO social_metrics (at, published, verified, removed, refused, engagement) VALUES (?,?,?,?,?,?)`, iso(t), row.published, row.verified, row.removed, row.refused, row.engagement);
  ctx?.notes?.push(`social metrics: ${JSON.stringify(row)}`);
}
