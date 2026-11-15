// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Queue score (US-SPEC-03 s4): s = impact * probability * (capability_gain + reach_gain) * (1 / remediation_cost) * trust * (1 + direction).
// Score rows carry their writer (US-01-R07): a persona replaces and deletes only the rows it wrote.
import { all, first, run, iso, TERMINAL_SQL } from '../kernel/util.js';
import { itemView } from './index.js';

const FOCUS_FACTORS = { impact: 5, probability: 5, capability_gain: 5, reach_gain: 5, remediation_cost: 1 };
const inRange = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

export function queueScore(f) {
  for (const k of ['impact', 'probability', 'capability_gain', 'reach_gain']) if (!inRange(f[k], 0, 5)) throw new Error(`${k} must be a number from 0 to 5`);
  if (!(typeof f.remediation_cost === 'number' && f.remediation_cost > 0)) throw new Error('remediation_cost must be above 0');
  if (!inRange(f.trust, 0, 1)) throw new Error('trust must be from 0 to 1');
  if (!inRange(f.direction, -1, 1)) throw new Error('direction must be from -1 to 1');
  return f.impact * f.probability * (f.capability_gain + f.reach_gain) * (1 / f.remediation_cost) * f.trust * (1 + f.direction);
}

// Score one item as a persona. A focus item takes the full factors; any other item needs the persona's assessment.
// trust defaults to the ledger reliability of the item's (surface, action class); direction defaults to 0.
export async function scoreItem(tools, personaId, itemId, factors = {}, { tickId = null } = {}) {
  const { db } = tools, pz = await tools.identity(personaId);
  if (!pz.authority.includes('score')) return tools.refuse(pz, 'score', itemId, 'authority', `score is not in the decision authority of ${pz.id}`, tickId);
  const it = await itemView(db, itemId);
  if (!it) return tools.refuse(pz, 'score', itemId, 'precondition', 'unknown item', tickId);
  if (it.plane !== pz.plane || (pz.program_id && it.program_id !== pz.program_id)) return tools.refuse(pz, 'score', itemId, 'lane', 'item is outside the lane of this persona', tickId);
  const focused = Boolean(await first(db, `SELECT 1 AS x FROM kernel_focus WHERE item_id = ?`, itemId));
  const led = it.surface && it.action_class ? await first(db, `SELECT reliability FROM trust_ledger WHERE surface = ? AND action_class = ?`, it.surface, it.action_class) : null;
  const f = { ...(focused ? FOCUS_FACTORS : {}), trust: led ? led.reliability : tools.config.default_trust, direction: 0, ...factors };
  let score;
  try { score = queueScore(f); } catch (e) { return tools.refuse(pz, 'score', itemId, 'precondition', e.message, tickId); }
  await run(db, `INSERT INTO staff_priority_scores (item_id, writer, impact, probability, capability_gain, reach_gain, remediation_cost, trust, direction, score, focused, at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(item_id, writer) DO UPDATE SET impact=excluded.impact, probability=excluded.probability, capability_gain=excluded.capability_gain,
        reach_gain=excluded.reach_gain, remediation_cost=excluded.remediation_cost, trust=excluded.trust, direction=excluded.direction,
        score=excluded.score, focused=excluded.focused, at=excluded.at`,
    itemId, pz.id, f.impact, f.probability, f.capability_gain, f.reach_gain, f.remediation_cost, f.trust, f.direction, score, focused ? 1 : 0, iso(tools.now()));
  return { ok: true, item_id: itemId, writer: pz.id, score, focused };
}

// US-01-R07: a persona deletes only rows it wrote. The writer comes from the identity, so no argument can name another's row.
export async function deleteScore(tools, personaId, itemId, { writer = null } = {}) {
  const pz = await tools.identity(personaId);
  if (writer && writer !== pz.id) return tools.refuse(pz, 'score:delete', itemId, 'lane', `the row was written by ${writer}`);
  const r = await run(tools.db, `DELETE FROM staff_priority_scores WHERE item_id = ? AND writer = ?`, itemId, pz.id);
  return { ok: true, deleted: r.meta.changes };
}

// The queue in score order. An item scored by several writers takes its most recent row; unscored items are not listed.
export async function rankQueue(db, { program_id = null } = {}) {
  const rows = await all(db, `SELECT s.*, i.priority, i.title, COALESCE(kp.program_id, i.project) AS program_id
      FROM staff_priority_scores s JOIN items i ON i.id = s.item_id LEFT JOIN kernel_projects kp ON kp.id = i.project
      WHERE i.status NOT IN ${TERMINAL_SQL}
        AND NOT EXISTS (SELECT 1 FROM staff_priority_scores n WHERE n.item_id = s.item_id AND (n.at > s.at OR (n.at = s.at AND n.writer > s.writer)))`);
  return rows.filter(r => program_id === null || r.program_id === program_id)
    .sort((a, b) => b.score - a.score || a.priority - b.priority || a.item_id.localeCompare(b.item_id));
}
