// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The post queue: drafts enter with an idempotency key, so the same text is queued once however often it is offered.
import { all, first, run, iso } from '../../core/kernel/util.js';
import { sha256 } from '../../core/packs/guard.js';

export const idemKey = async text => `social:${(await sha256(text)).slice(0, 24)}`;

// Predicted engagement: the mean of the last scored posts, else the configured baseline.
export async function predictEngagement(db, s) {
  const r = await first(db, `SELECT AVG(engagement) AS m FROM (SELECT engagement FROM social_queue WHERE engagement_verdict IS NOT NULL ORDER BY id DESC LIMIT 20)`);
  return r && r.m != null ? Number(r.m) : s.baseline_engagement;
}

export async function enqueue({ db, now, s, text, claimIds, replyTo = null }) {
  const key = await idemKey(text);
  const predicted = await predictEngagement(db, s);
  const r = await run(db, `INSERT OR IGNORE INTO social_queue (idem_key, text, claim_ids, reply_to, predicted_engagement, created_at) VALUES (?,?,?,?,?,?)`,
    key, text, JSON.stringify(claimIds), replyTo, predicted, iso(now()));
  const created = (r.meta?.changes ?? 0) > 0;
  const row = await first(db, `SELECT id FROM social_queue WHERE idem_key = ?`, key);
  if (created) {
    await run(db, `INSERT OR IGNORE INTO predictions (id, metric, op, target, due_at) VALUES (?,?,?,?,?)`,
      `social-engagement-${row.id}`, 'social_post_engagement', '>=', predicted, iso(now() + s.score_after_hours * 3600e3));
  }
  return { id: row.id, created, key };
}

export const backlog = async db => (await first(db, `SELECT COUNT(*) AS n FROM social_queue WHERE status IN ('queued','awaiting_approval')`)).n;
export const recentClaimIds = async (db, now, days) => {
  const ids = new Set();
  for (const r of await all(db, `SELECT claim_ids FROM social_queue WHERE created_at >= ?`, iso(now - days * 86400e3))) for (const id of JSON.parse(r.claim_ids)) ids.add(id);
  return ids;
};
