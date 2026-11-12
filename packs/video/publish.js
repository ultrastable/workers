// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Publish through guard.send on channel 'video'. The guard holds the caps, kill switch and approval by rung.
// The text the guard sees (and a person approves) is the title, description and provenance hash; the file travels by reference.
import { all, first, run, iso } from '../../core/kernel/util.js';
import { cfg } from './lib.js';

export const CHANNEL = 'video';
const TRANSIENT = /^(cap_per_day|cap_per_week|kill_switch_\w+|pack_disabled|delivery_failed.*)$/;

export const cardText = r => `${r.title}\n${r.description}\n[provenance ${r.provenance_hash.slice(0, 16)}, ${r.duration_s}s]`;

export function guardPort({ db, channel, maxLength = 4000 }) {
  return {
    maxLength,
    async send({ idempotencyKey }) {
      const r = await first(db, `SELECT * FROM video_queue WHERE idem_key = ?`, idempotencyKey);
      if (!r) throw new Error('queue row not found');
      const res = await channel.publish({ title: r.title, description: r.description, assetRef: r.asset_ref, assetSha256: r.asset_sha256,
        durationS: r.duration_s, provenance: JSON.parse(r.provenance_json), provenanceHash: r.provenance_hash });
      if (res?.url) await run(db, `UPDATE video_queue SET url = ? WHERE idem_key = ?`, res.url, idempotencyKey);
      return { id: res.id };
    },
  };
}

// Brings queue rows in line with what the guard recorded (sent, approved, rejected), so a retry records exactly once.
export async function reconcile(db) {
  for (const r of await all(db, `SELECT * FROM video_queue WHERE status IN ('queued','awaiting_approval') ORDER BY id`)) {
    const sent = await first(db, `SELECT provider_id, at FROM guard_ledger WHERE pack = 'video' AND idem_key = ? AND decision = 'sent' ORDER BY id DESC`, r.idem_key);
    if (sent) await run(db, `UPDATE video_queue SET status = 'published', provider_id = ?, published_at = ?, guard_reason = NULL WHERE id = ?`, sent.provider_id, sent.at, r.id);
    else if (r.status === 'awaiting_approval') {
      const g = await first(db, `SELECT status, reason FROM guard_queue WHERE id = ?`, r.guard_queue_id);
      if (g && (g.status === 'rejected' || g.status === 'refused')) await run(db, `UPDATE video_queue SET status = 'refused', guard_reason = ? WHERE id = ?`, g.reason || g.status, r.id);
    }
  }
}

export async function publishLoop({ db, ctx, now, settings, guard }) {
  const s = cfg(settings);
  await reconcile(db);
  const notes = [];
  for (const r of await all(db, `SELECT * FROM video_queue WHERE status = 'queued' ORDER BY id LIMIT 5`)) {
    await run(db, `UPDATE video_queue SET attempts = attempts + 1 WHERE id = ?`, r.id);
    const res = await guard.send({ channel: CHANNEL, kind: 'video', recipient: s.handle, content: cardText(r), idempotencyKey: r.idem_key });
    if (res.decision === 'sent') {
      await run(db, `UPDATE video_queue SET status = 'published', provider_id = ?, published_at = ?, guard_reason = NULL WHERE id = ?`, res.providerId ?? null, iso(now()), r.id);
      notes.push(`video ${r.id} published`);
    } else if (res.decision === 'queued_for_approval') {
      await run(db, `UPDATE video_queue SET status = 'awaiting_approval', guard_queue_id = ?, card_id = ?, guard_reason = ? WHERE id = ?`, res.queueId, res.cardId, res.reason, r.id);
      notes.push(`video ${r.id} waits on decision card ${res.cardId}`);
    } else if (res.reason === 'duplicate_idempotency_key') {
      await reconcile(db);
    } else if (TRANSIENT.test(res.reason) && !(res.reason.startsWith('delivery_failed') && r.attempts + 1 >= 3)) {
      await run(db, `UPDATE video_queue SET guard_reason = ? WHERE id = ?`, res.reason, r.id);
      notes.push(`held: ${res.reason}`);
      if (/^(cap_|kill_switch|pack_disabled)/.test(res.reason)) break;
    } else {
      await run(db, `UPDATE video_queue SET status = 'refused', guard_reason = ? WHERE id = ?`, res.reason, r.id);
      notes.push(`video ${r.id} refused: ${res.reason}`);
    }
  }
  ctx?.notes?.push(`video publish: ${notes.join('; ') || 'nothing queued'}`);
}
