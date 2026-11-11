// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Loop 4: re-read each published post through the channel port. A post that cannot be confirmed is an incident item.
import { all, run, iso, parseIso } from '../../core/kernel/util.js';
import { cfg, fileItem } from './lib.js';

const norm = t => String(t ?? '').replace(/\s+/g, ' ').trim();

export async function verifyLoop({ db, ctx, now, settings }) {
  const s = cfg(settings);
  const channel = s.ports.channel;
  if (!channel) throw new Error('social channel port is not configured');
  let ok = 0, failed = 0, waiting = 0;
  for (const r of await all(db, `SELECT * FROM social_queue WHERE status = 'published' AND verify_status IS NULL ORDER BY id LIMIT 20`)) {
    let post = null, error = null;
    try { post = r.provider_id ? await channel.fetchPost(r.provider_id) : null; } catch (e) { error = e.message; }
    const attempts = r.verify_attempts + 1;
    if (post && post.state === 'pending') {                                  // a scheduler has it but has not published yet
      const age = now() - parseIso(r.published_at);
      if (age < s.verify_pending_hours * 3600e3) { waiting++; continue; }
    }
    if (post && post.state !== 'pending' && (post.text === undefined || norm(post.text) === norm(r.text))) {
      await run(db, `UPDATE social_queue SET verify_status = 'verified', verified_at = ?, verify_attempts = ?, url = COALESCE(?, url) WHERE id = ?`, iso(now()), attempts, post.url ?? null, r.id);
      ok++;
    } else if (attempts >= s.verify_attempts || (post && post.state === 'pending')) {
      await run(db, `UPDATE social_queue SET verify_status = 'failed', verify_attempts = ? WHERE id = ?`, attempts, r.id);
      await fileItem(db, `SOCIALVERIFY-${r.id}`, `Social post ${r.id} could not be verified after publishing${error ? ` (${error.slice(0, 80)})` : ''}`, `post ${r.id} read back through the channel, or removed from the record with the reason`);
      failed++;
    } else {
      await run(db, `UPDATE social_queue SET verify_attempts = ? WHERE id = ?`, attempts, r.id);
      waiting++;
    }
  }
  ctx?.notes?.push(`social verify: ${ok} verified, ${failed} failed, ${waiting} waiting`);
}
