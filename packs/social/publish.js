// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Loop 3: publish through guard.send on channel 'social' (caps, kill switch, approval by rung all live in the guard).
// The loop reconciles first, so a retry after a crash, or an approval given on the decision card, is recorded exactly once.
import { all, first, run, iso } from '../../core/kernel/util.js';
import { cfg } from './lib.js';
import { findUrls } from './text.js';

export const CHANNEL = 'social';
const TRANSIENT = /^(cap_per_day|cap_per_week|kill_switch_\w+|pack_disabled|delivery_failed.*)$/;

// The guard's channel port for 'social': the guard hands it only text, so links come from the text and a thread parent from the queue.
export function guardPort({ db, channel, maxLength = 300 }) {
  return {
    maxLength,
    async send({ content, idempotencyKey }) {
      const row = await first(db, `SELECT reply_to FROM social_queue WHERE idem_key = ?`, idempotencyKey);
      const res = await channel.post({ text: content, links: findUrls(content).map(u => u.url), replyTo: row?.reply_to || undefined });
      if (res?.url) await run(db, `UPDATE social_queue SET url = ? WHERE idem_key = ?`, res.url, idempotencyKey);
      return { id: res.id };
    },
  };
}

// Brings queue rows in line with what the guard recorded (sent, approved, rejected).
export async function reconcile(db) {
  for (const r of await all(db, `SELECT * FROM social_queue WHERE status IN ('queued','awaiting_approval') ORDER BY id`)) {
    const sent = await first(db, `SELECT provider_id, at FROM guard_ledger WHERE pack = 'social' AND idem_key = ? AND decision = 'sent' ORDER BY id DESC`, r.idem_key);
    if (sent) {
      await run(db, `UPDATE social_queue SET status = 'published', provider_id = ?, published_at = ?, guard_reason = NULL WHERE id = ?`, sent.provider_id, sent.at, r.id);
    } else if (r.status === 'awaiting_approval') {
      const g = await first(db, `SELECT status, reason FROM guard_queue WHERE id = ?`, r.guard_queue_id);
      if (g && (g.status === 'rejected' || g.status === 'refused')) await run(db, `UPDATE social_queue SET status = 'refused', guard_reason = ? WHERE id = ?`, g.reason || g.status, r.id);
    }
  }
}

const countSince = (db, ms) => first(db, `SELECT COUNT(*) AS n FROM social_queue WHERE status IN ('published','removed') AND published_at > ?`, iso(ms));

export async function publishLoop({ db, ctx, now, pack, settings, guard }) {
  const s = cfg(settings);
  await reconcile(db);
  const caps = pack?.outbound?.caps?.[CHANNEL] || {};
  const notes = [];
  for (const r of await all(db, `SELECT * FROM social_queue WHERE status = 'queued' ORDER BY id LIMIT 20`)) {
    // Stay under the caps without asking the guard to refuse every tick; the guard remains the enforcer.
    if (caps.per_day != null && (await countSince(db, now() - 86400e3)).n >= caps.per_day) { notes.push('daily cap reached'); break; }
    if (caps.per_week != null && (await countSince(db, now() - 7 * 86400e3)).n >= caps.per_week) { notes.push('weekly cap reached'); break; }
    await run(db, `UPDATE social_queue SET attempts = attempts + 1 WHERE id = ?`, r.id);
    const res = await guard.send({ channel: CHANNEL, kind: 'post', recipient: s.handle, content: r.text, idempotencyKey: r.idem_key });
    if (res.decision === 'sent') {
      await run(db, `UPDATE social_queue SET status = 'published', provider_id = ?, published_at = ?, guard_reason = NULL WHERE id = ?`, res.providerId ?? null, iso(now()), r.id);
    } else if (res.decision === 'queued_for_approval') {
      await run(db, `UPDATE social_queue SET status = 'awaiting_approval', guard_queue_id = ?, card_id = ?, guard_reason = ? WHERE id = ?`, res.queueId, res.cardId, res.reason, r.id);
      notes.push(`post ${r.id} waits on decision card ${res.cardId}`);
    } else if (res.reason === 'duplicate_idempotency_key') {
      await reconcile(db);
    } else if (TRANSIENT.test(res.reason) && !(res.reason.startsWith('delivery_failed') && r.attempts + 1 >= 3)) {
      await run(db, `UPDATE social_queue SET guard_reason = ? WHERE id = ?`, res.reason, r.id);
      notes.push(`held: ${res.reason}`);
      break;                                                       // do not hammer a closed door
    } else {
      await run(db, `UPDATE social_queue SET status = 'refused', guard_reason = ? WHERE id = ?`, res.reason, r.id);
    }
  }
  ctx?.notes?.push(`social publish: ${notes.join('; ') || 'ok'}`);
}
