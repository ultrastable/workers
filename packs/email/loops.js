// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tick-step entries named in pack.json. The host calls each with { db, ctx, now, pack, settings, guard } (guard bound to this pack).
// settings: { baseUrl, senderLine, hashSalt, linkSecret, batch_size, ... }; values come from configuration, never from defaults here.
import { createEmail } from './service.js';

export function serviceFrom({ db, now, settings, guard }) {
  return createEmail({
    db, guard, now,
    config: { ...settings, batchSize: settings.batch_size, confirmResendMinutes: settings.confirm_resend_minutes, subscribePerHour: settings.subscribe_per_hour },
  });
}

// Newsletter and notice loop: queued messages go to confirmed, non-suppressed subscribers in batches, through guard.send only.
export async function send({ db, ctx, now, settings, guard }) {
  const r = await serviceFrom({ db, now, settings, guard }).sendPending();
  ctx.notes.push(`email send: sent ${r.sent}, skipped ${r.skipped}, queued ${r.queued}, failed ${r.failed}${r.stopped ? `, stopped (${r.stopped})` : ''}`);
}

// Metrics step: confirmed, pending, unsubscribed and bounced counts for the pack manager.
export async function metrics({ db, ctx, now, settings, guard }) {
  const m = await serviceFrom({ db, now, settings, guard }).writeMetrics();
  ctx.notes.push(`email metrics: confirmed ${m.confirmed}, pending ${m.pending}, unsubscribed ${m.unsubscribed}, bounced ${m.bounced}`);
}
