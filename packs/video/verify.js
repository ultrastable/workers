// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Re-read each published video through the channel port: live, and carrying the same provenance hash.
import { all, run, iso, parseIso } from '../../core/kernel/util.js';
import { cfg, fileItem } from './lib.js';

export async function verifyLoop({ db, ctx, now, settings }) {
  const s = cfg(settings);
  const channel = s.ports.channel;
  if (!channel) throw new Error('video channel port is not configured');
  let ok = 0, failed = 0, waiting = 0;
  for (const r of await all(db, `SELECT * FROM video_queue WHERE status = 'published' AND verify_status IS NULL ORDER BY id LIMIT 20`)) {
    let v = null, error = null;
    try { v = r.provider_id ? await channel.fetchVideo(r.provider_id) : null; } catch (e) { error = e.message; }
    const attempts = r.verify_attempts + 1;
    if (v && v.state === 'processing' && now() - parseIso(r.published_at) < s.verify_pending_hours * 3600e3) { waiting++; continue; }
    const live = v && v.state === 'published';
    const same = live && (v.provenanceHash === undefined || v.provenanceHash === r.provenance_hash);
    if (same) {
      await run(db, `UPDATE video_queue SET verify_status = 'verified', verified_at = ?, verify_attempts = ?, url = COALESCE(?, url) WHERE id = ?`, iso(now()), attempts, v.url ?? null, r.id);
      ok++;
    } else if (attempts >= s.verify_attempts || (v && v.state === 'processing') || (live && !same)) {
      await run(db, `UPDATE video_queue SET verify_status = 'failed', verify_attempts = ? WHERE id = ?`, attempts, r.id);
      await fileItem(db, `VIDEOVERIFY-${r.id}`, `Video ${r.id} could not be verified after publishing${live && !same ? ' (provenance hash differs)' : error ? ` (${error.slice(0, 80)})` : ''}`, `video ${r.id} read back with its provenance hash, or taken down and recorded with the reason`);
      failed++;
    } else { await run(db, `UPDATE video_queue SET verify_attempts = ? WHERE id = ?`, attempts, r.id); waiting++; }
  }
  ctx?.notes?.push(`video verify: ${ok} verified, ${failed} failed, ${waiting} waiting`);
}
