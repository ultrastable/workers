// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// At most one tick per slot (US-14-R03, US-14-R09, US-14-T03). A scheduler may deliver the same firing twice, and two instances
// may receive it at once: the handler inserts the slot number first and returns without running when the insert conflicts.
// The slot is kept even if the tick fails, so a slot never holds two ticks; the next slot runs normally.
export const SLOT_MS = 600000;
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/** Try to take the slot that `now` falls in. Returns { won, slot }. */
export async function claimSlot(db, now = Date.now(), { slotMs = SLOT_MS } = {}) {
  const slot = Math.floor(now / slotMs);
  const r = await db.prepare(`INSERT OR IGNORE INTO sched_slots (slot, claimed_at) VALUES (?, ?)`).bind(slot, iso(now)).run();
  return { won: (r.meta?.changes ?? 0) === 1, slot };
}

/** Run `tick()` only if this call takes the slot. `tick` is the adapter's call to runTick and should resolve to its result
 *  ({ tickId, completed, total }). Returns { ran, slot, result } or { ran: false, slot, duplicate: true }. */
export async function runOncePerSlot(db, tick, { now = Date.now(), slotMs = SLOT_MS } = {}) {
  const { won, slot } = await claimSlot(db, now, { slotMs });
  if (!won) return { ran: false, slot, duplicate: true };
  const mark = (id, outcome) => db.prepare(`UPDATE sched_slots SET tick_run_id=?, outcome=? WHERE slot=?`).bind(id ?? null, outcome, slot).run();
  try {
    const result = await tick();
    await mark(result?.tickId, result && result.completed === result.total ? 'completed' : 'incomplete');
    return { ran: true, slot, result };
  } catch (e) {
    await mark(null, 'error');
    throw e;
  }
}
