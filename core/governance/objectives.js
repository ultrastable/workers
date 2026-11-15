// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Objective space and self-authored goals (US-SPEC-07 section 3.2). A ratified objective is written only by the principal or
// a ratification action; an objective revision an agent authors stays `proposed` (US-07-R14). A goal is adopted with a parent
// objective and an alignment sentence, or enters probation with a deadline and is not dispatchable (US-07-R15).
import { all, first, run, iso } from './register.js';

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'in', 'on', 'for', 'by', 'with', 'is', 'are', 'be', 'at', 'as', 'that', 'this', 'it']);
const stem = (w) => w.replace(/(ing|ed|es|s)$/, '');
export const tokens = (text) => new Set(String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1 && !STOP.has(w)).map(stem));

/** Jaccard and containment similarity of two token sets. Containment is the shared share of the smaller set. */
export function similarity(a, b) {
  const A = a instanceof Set ? a : tokens(a), B = b instanceof Set ? b : tokens(b);
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  const union = A.size + B.size - shared, small = Math.min(A.size, B.size);
  return { jaccard: union ? shared / union : 0, containment: small ? shared / small : 0, shared };
}

export const scoreGoal = (c) => 0.4 * c.falsifiability + 0.4 * c.leverage + 0.2 * c.novelty;

/** Only the principal, or a ratification action that names the principal's act, writes a ratified objective. */
export async function ratifyObjective(db, o, { now = Date.now() } = {}) {
  if (!o.id || !o.text) throw new Error('objective requires id and text');
  if (o.by !== 'principal' && !(o.by === 'ratification' && o.ratification_ref)) throw new Error('a ratified objective is written only by the principal or a ratification action');
  const nowIso = iso(now);
  await run(db, `INSERT INTO governance_objectives (id, text, status, author, ratified_by, created_at, decided_at) VALUES (?,?, 'ratified', ?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET text=excluded.text, status='ratified', ratified_by=excluded.ratified_by, decided_at=excluded.decided_at`,
    o.id, o.text, o.author || o.by, o.by === 'principal' ? 'principal' : `ratification:${o.ratification_ref}`, nowIso, nowIso);
  return { id: o.id, status: 'ratified' };
}

/** An agent's candidate that would change the mission, the objective weights or the boundary of consent: stored `proposed`. */
export async function proposeRevision(db, o, { now = Date.now() } = {}) {
  if (!o.id || !o.text || !o.author) throw new Error('objective revision requires id, text and author');
  await run(db, `INSERT INTO governance_objectives (id, text, status, author, revises, created_at) VALUES (?,?, 'proposed', ?,?,?)`, o.id, o.text, o.author, o.revises ?? null, iso(now));
  return { id: o.id, status: 'proposed' };
}

/**
 * US-07-R14, T06: change the status of an objective row. `adopted`, `active` and `ratified` are refused for the authoring
 * agent and for any actor that is not the principal or a ratification action.
 */
export async function setObjectiveStatus(db, id, status, { by, ratification_ref, now = Date.now() } = {}) {
  const o = await first(db, `SELECT * FROM governance_objectives WHERE id = ?`, id);
  if (!o) throw new Error(`unknown objective ${id}`);
  if (['adopted', 'active', 'ratified'].includes(status)) {
    if (by === o.author) return { ok: false, reason: 'an objective revision is never adopted by its authoring agent' };
    if (by !== 'principal' && !(by === 'ratification' && ratification_ref)) return { ok: false, reason: 'only the principal or a ratification action adopts an objective' };
    await run(db, `UPDATE governance_objectives SET status='ratified', ratified_by=?, decided_at=? WHERE id=?`, by === 'principal' ? 'principal' : `ratification:${ratification_ref}`, iso(now), id);
    return { ok: true, status: 'ratified' };
  }
  if (!['proposed', 'rejected'].includes(status)) return { ok: false, reason: `unknown status ${status}` };
  await run(db, `UPDATE governance_objectives SET status=?, decided_at=? WHERE id=?`, status, iso(now), id);
  return { ok: true, status };
}

/**
 * One adoption cycle over candidates [{ id, text, definition_of_done, falsifiability, leverage, novelty, parent_objective?,
 * alignment?, done_probe?, author }]. Rejects below the score threshold, rejects near-duplicates of goals adopted in the last
 * 30 days (Jaccard or containment at or above 0.6), anchors by stem match to a ratified objective, and adopts at most N,
 * highest score first. A goal with no ratified anchor is novel: probation with a deadline, not dispatchable.
 */
export async function adoptGoals(db, candidates, { now = Date.now(), threshold = 0.5, max = 3, similar = 0.6, probation_days = 14, anchor_min = 0.3 } = {}) {
  const nowIso = iso(now);
  const recent = await all(db, `SELECT id, text FROM governance_goals WHERE adopted_at >= ?`, iso(now - 30 * 86400e3));
  const objectives = await all(db, `SELECT id, text FROM governance_objectives WHERE status = 'ratified' ORDER BY id`);
  const out = { adopted: [], rejected: [] };
  const ranked = candidates.map(c => ({ ...c, score: scoreGoal(c) })).sort((a, b) => b.score - a.score);
  for (const c of ranked) {
    const no = (reason) => out.rejected.push({ id: c.id, reason });
    if (!c.definition_of_done || !String(c.definition_of_done).trim()) { no('no definition of done: not falsifiable'); continue; }
    if (c.score < threshold) { no(`score ${c.score.toFixed(2)} below ${threshold}`); continue; }
    const dup = recent.find(g => { const s = similarity(c.text, g.text); return s.jaccard >= similar || s.containment >= similar; });
    if (dup) { no(`near-duplicate of ${dup.id}`); continue; }
    if (out.adopted.length >= max) { no(`cycle limit of ${max} reached`); continue; }
    let parent = c.parent_objective && objectives.find(o => o.id === c.parent_objective) ? c.parent_objective : null;
    if (!parent) { // anchor by stem match
      const best = objectives.map(o => ({ id: o.id, s: similarity(c.text, o.text).containment })).sort((a, b) => b.s - a.s)[0];
      if (best && best.s >= anchor_min) parent = best.id;
    }
    const derived = Boolean(parent && c.alignment && String(c.alignment).trim());
    await run(db, `INSERT INTO governance_goals (id, text, definition_of_done, kind, status, parent_objective, alignment, score, probation_until, dispatchable, author, done_probe, adopted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      c.id, c.text, c.definition_of_done, derived ? 'derived' : 'novel', derived ? 'adopted' : 'probation', derived ? parent : null, derived ? c.alignment : null, c.score,
      derived ? null : iso(now + probation_days * 86400e3), derived ? 1 : 0, c.author ?? null, c.done_probe ?? null, nowIso);
    if (derived) await run(db, `INSERT INTO governance_goal_ledger (goal_id, queued_at) VALUES (?,?)`, c.id, nowIso);
    recent.push({ id: c.id, text: c.text });
    out.adopted.push({ id: c.id, kind: derived ? 'derived' : 'novel', status: derived ? 'adopted' : 'probation', parent_objective: derived ? parent : null, score: c.score });
  }
  return out;
}

/** The worker side of the ledger: each queued goal becomes a work item, so an adopted goal is never inert. */
export async function drainGoalLedger(db, { now = Date.now(), owner_role = 'operations' } = {}) {
  const nowIso = iso(now), made = [];
  for (const l of await all(db, `SELECT l.id, g.id AS goal_id, g.text, g.definition_of_done, g.done_probe FROM governance_goal_ledger l JOIN governance_goals g ON g.id = l.goal_id
      WHERE l.drained_at IS NULL AND g.status = 'adopted' AND g.dispatchable = 1 ORDER BY l.id`)) {
    const item = `GOAL-${l.goal_id}`;
    await run(db, `INSERT OR IGNORE INTO items (id, title, kind, owner_role, done_check, closing_probe, priority, status, created_at, updated_at) VALUES (?,?,'work',?,?,?,40,'ready',?,?)`,
      item, String(l.text).slice(0, 300), owner_role, l.definition_of_done, l.done_probe ?? null, nowIso, nowIso);
    await run(db, `UPDATE governance_goal_ledger SET drained_at=?, item_id=? WHERE id=?`, nowIso, item, l.id);
    made.push(item);
  }
  return made;
}

/** Retire a goal when its done probe passed (`done`), when it is stale beyond `stale_days`, or when probation lapsed. */
export async function retireGoals(db, { now = Date.now(), stale_days = 30 } = {}) {
  const nowIso = iso(now), out = [];
  for (const g of await all(db, `SELECT * FROM governance_goals WHERE status IN ('adopted','probation') ORDER BY id`)) {
    const item = await first(db, `SELECT status FROM items WHERE id = ?`, `GOAL-${g.id}`);
    const reason = item && item.status === 'done' ? 'done probe passed'
      : g.status === 'probation' && g.probation_until <= nowIso ? 'probation deadline passed without ratification'
      : g.adopted_at <= iso(now - stale_days * 86400e3) ? `stale beyond ${stale_days} days` : null;
    if (!reason) continue;
    await run(db, `UPDATE governance_goals SET status='retired', retired_at=?, retire_reason=? WHERE id=?`, nowIso, reason, g.id);
    out.push({ id: g.id, reason });
  }
  return out;
}
