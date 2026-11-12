// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Entry point for whoever makes a video: submitVideo checks it, records provenance and queues it once (idempotent by asset hash).
import { all, first, run, iso } from '../../core/kernel/util.js';
import { cfg, provenanceHash, canonicalProvenance } from './lib.js';
import { checkVideo } from './check.js';

export async function submitVideo({ db, now = Date.now, settings = {}, video }) {
  const s = cfg(settings);
  const claims = await all(db, `SELECT id, public, last_result, last_checked_at, max_age_hours FROM describe_claims`);
  const res = checkVideo(video, { claims, allowlist: s.allowlist, max_seconds: s.max_seconds, disclosure: s.disclosure, now: now() });
  if (!res.ok) {
    await run(db, `INSERT INTO video_rejections (at, title, violations) VALUES (?,?,?)`, iso(now()), String(video?.title ?? '').slice(0, 200), JSON.stringify(res.violations));
    return { queued: false, violations: res.violations };
  }
  const idem = `video:${video.asset_sha256.slice(0, 24)}`;
  if (await first(db, `SELECT 1 AS x FROM video_queue WHERE idem_key = ?`, idem)) return { queued: false, duplicate: true };
  if ((await first(db, `SELECT COUNT(*) AS n FROM video_queue WHERE status IN ('queued','awaiting_approval')`)).n >= s.max_backlog) return { queued: false, backlog_full: true };
  const ph = await provenanceHash(video.asset_sha256, video.provenance);
  const r = await run(db, `INSERT INTO video_queue (idem_key, title, description, duration_s, asset_ref, asset_sha256, provenance_json, provenance_hash, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, idem, video.title.trim(), video.description, video.duration_s, video.asset_ref, video.asset_sha256,
    canonicalProvenance(video.asset_sha256, video.provenance), ph, iso(now()));
  return { queued: true, id: r.meta.last_row_id, provenanceHash: ph };
}
