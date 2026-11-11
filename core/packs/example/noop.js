// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The contract in one function. The host calls it as a guarded tick step with { db, ctx, now, pack, settings, guard }.
// The only way out of the organization is guard.send; the host binds the guard to this pack's id.
export async function run({ ctx, now, settings, guard }) {
  const recipients = settings.recipients || [];
  const results = [];
  for (const recipient of recipients) {
    const day = new Date(now()).toISOString().slice(0, 10);
    results.push(await guard.send({
      channel: 'fake', kind: 'notice', recipient, content: 'Notice from the example pack.',
      idempotencyKey: `notice:${recipient}:${day}`, // one per recipient per day, safe to retry
    }));
  }
  ctx.notes.push(`example pack: ${results.map(r => r.decision).join(', ') || 'no recipients'}`);
}
