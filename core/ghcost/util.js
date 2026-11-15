// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Shared helpers of core/ghcost: time, db calls, items, gate cards and probe records. No ambient state.
export const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
export const nowMs = ctx => { const v = typeof ctx.now === 'function' ? ctx.now() : ctx.now; return v instanceof Date ? v.getTime() : Number(v); };
export const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
export const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
export const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
export const cfg = ctx => ctx.config?.ghcost || {};
const TERMINAL = "('done','superseded','cancelled')";

/** Open an item once; a recurrence re-opens an item this module closed earlier. Returns true when it was filed or re-opened. */
export async function fileItem(db, { id, title, done_check, closing_probe, priority = 20, owner_role = 'operations' }, ts) {
  const r = await run(db, `INSERT OR IGNORE INTO items (id, title, kind, owner_role, done_check, closing_probe, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    id, String(title).slice(0, 300), 'fix', owner_role, done_check, closing_probe, priority, ts, ts);
  if (r.meta.changes) return true;
  const re = await run(db, `UPDATE items SET status='open', disposition=NULL, title=?, updated_at=? WHERE id=? AND status='done'`, String(title).slice(0, 300), ts, id);
  return re.meta.changes > 0;
}
/** Close an item with a disposition (the evidence that its probe passed). */
export async function closeItem(db, id, disposition, ts) {
  const r = await run(db, `UPDATE items SET status='done', disposition=?, updated_at=? WHERE id=? AND status NOT IN ${TERMINAL}`, String(disposition).slice(0, 300), ts, id);
  return r.meta.changes > 0;
}
/** A gate card with its default already in effect (US-SPEC-06). Idempotent by id. */
export async function openCard(db, { id, what, why_gated, default_in_effect, prepared_by_fleet = null, closing_probe = 'manual' }) {
  const r = await run(db, `INSERT OR IGNORE INTO gate_cards (id, what, why_gated, default_in_effect, prepared_by_fleet, closing_probe) VALUES (?,?,?,?,?,?)`,
    id, what, why_gated, default_in_effect, prepared_by_fleet, closing_probe);
  return r.meta.changes > 0;
}
export const recordProbe = (db, probe, result, evidence, ts) =>
  run(db, `INSERT INTO ghcost_probes (probe, result, evidence, checked_at) VALUES (?,?,?,?)`, probe, result, typeof evidence === 'string' ? evidence.slice(0, 1000) : JSON.stringify(evidence).slice(0, 1000), ts);
