// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Apply: each queued request goes through guard.send (viaDeploy) and the guard's port calls core/deploy, which owns the lock,
// version check, probes and rollback. The port records the deploy result on the request before it returns or throws.
import { all, first, run, iso } from '../../core/kernel/util.js';
import { cfg, CHANNEL } from './lib.js';

const TRANSIENT = /^(cap_per_day|cap_per_week|kill_switch_\w+|pack_disabled)$/;
const STATUS = { kept: 'deployed', reverted: 'reverted', failed: 'failed', refused: 'refused' };

// deploys: { cloudflare: createDeploy(...), gcp: createDeploy(...) }; artifacts: async ({ provider, unit, version, sha256 }) -> { version, ... }.
export function guardPort({ db, deploys, artifacts, now = Date.now }) {
  return {
    maxLength: 2000,
    async send({ idempotencyKey }) {
      const r = await first(db, `SELECT * FROM cloud_requests WHERE idem_key = ?`, idempotencyKey);
      if (!r) throw new Error('request not found');
      const deploy = deploys[r.provider];
      if (!deploy) throw new Error(`no deploy path for provider ${r.provider}`);
      const artifact = await artifacts({ provider: r.provider, unit: r.unit, version: r.version, sha256: r.artifact_sha256 });
      const res = await deploy.deploy({ unit: r.unit, artifact: { ...artifact, version: r.version, ...(r.artifact_sha256 ? { sha256: r.artifact_sha256 } : {}) },
        expectedVersion: r.expected_version ?? undefined, actor: 'pack:cloud' });
      await run(db, `UPDATE cloud_requests SET status = ?, ledger_id = ?, detail = ?, finished_at = ? WHERE id = ?`,
        STATUS[res.status] || 'failed', res.id ?? null, res.reason ?? null, iso(now()), r.id);
      if (res.status !== 'kept') throw new Error(`deploy_${res.status}: ${String(res.reason ?? '').slice(0, 80)}`);
      return { id: String(res.id) };
    },
  };
}

export async function applyLoop({ db, ctx, now, settings, guard }) {
  cfg(settings);
  const notes = [];
  for (const r of await all(db, `SELECT * FROM cloud_requests WHERE status IN ('queued','awaiting_approval') ORDER BY id LIMIT 5`)) {
    const sent = await first(db, `SELECT provider_id, at FROM guard_ledger WHERE pack = 'cloud' AND idem_key = ? AND decision = 'sent' ORDER BY id DESC`, r.idem_key);
    if (sent) {                                                          // approved on the card, or recorded before a crash
      if (r.status !== 'deployed') await run(db, `UPDATE cloud_requests SET status = 'deployed', ledger_id = COALESCE(ledger_id, ?), finished_at = COALESCE(finished_at, ?) WHERE id = ?`, Number(sent.provider_id) || null, sent.at, r.id);
      continue;
    }
    if (r.status === 'awaiting_approval') {
      const g = await first(db, `SELECT status, reason FROM guard_queue WHERE id = ?`, r.guard_queue_id);
      if (g && (g.status === 'rejected' || g.status === 'refused')) await run(db, `UPDATE cloud_requests SET status = 'refused', guard_reason = ?, finished_at = ? WHERE id = ?`, g.reason || g.status, iso(now()), r.id);
      continue;
    }
    await run(db, `UPDATE cloud_requests SET attempts = attempts + 1 WHERE id = ?`, r.id);
    const res = await guard.send({ channel: CHANNEL, kind: 'deploy', recipient: `${r.provider}:${r.unit}`, content: JSON.stringify({ provider: r.provider, unit: r.unit, version: r.version }),
      idempotencyKey: r.idem_key, viaDeploy: true });
    if (res.decision === 'sent') { notes.push(`${r.unit}@${r.version} deployed`); continue; }
    if (res.decision === 'queued_for_approval') {
      await run(db, `UPDATE cloud_requests SET status = 'awaiting_approval', guard_queue_id = ?, card_id = ?, guard_reason = ? WHERE id = ?`, res.queueId, res.cardId, res.reason, r.id);
      notes.push(`${r.unit}@${r.version} waits on decision card ${res.cardId}`);
    } else if (TRANSIENT.test(res.reason)) {
      await run(db, `UPDATE cloud_requests SET guard_reason = ? WHERE id = ?`, res.reason, r.id);
      notes.push(`held: ${res.reason}`);
      break;
    } else if (res.reason.startsWith('delivery_failed')) {                 // deploy ran and recorded its own result on the request
      notes.push(`${r.unit}@${r.version} ${res.reason.slice(0, 60)}`);
    } else {
      await run(db, `UPDATE cloud_requests SET status = 'refused', guard_reason = ?, finished_at = ? WHERE id = ?`, res.reason, iso(now()), r.id);
      notes.push(`${r.unit}@${r.version} refused: ${res.reason}`);
    }
  }
  ctx?.notes?.push(`cloud apply: ${notes.join('; ') || 'nothing queued'}`);
}
