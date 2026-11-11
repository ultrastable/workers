// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Decision log with prediction, authority and revert path (US-SPEC-05, US-SPEC-15 A-EXE-3), and the
// keep-or-revert rule: a target-metric gain is kept only if no guard metric is breached, unmeasured or worse.
import { all, first, run, iso, parseIso, compare, improvement, ensureItem } from './util.js';
import { readMetric } from './metrics.js';

const NUM = '(-?\\d+(?:\\.\\d+)?)';
const RE_SIMPLE = new RegExp(`^\\s*([A-Za-z0-9_.:-]+)\\s*(>=|<=|>|<|=)\\s*${NUM}\\s+within\\s+(\\d+(?:\\.\\d+)?)\\s*h\\s*$`);
const RE_BETWEEN = new RegExp(`^\\s*([A-Za-z0-9_.:-]+)\\s+between\\s+${NUM}\\s+and\\s+${NUM}\\s+within\\s+(\\d+(?:\\.\\d+)?)\\s*h\\s*$`);
const RE_ISSUE = /^\s*issue\s+([A-Za-z0-9_.:-]+)\s+closed\s+within\s+(\d+(?:\.\d+)?)\s*h\s*$/;

// US-05-R07 / US-05-T03: the parsable forms. Returns null when the text is not parsable.
export function parsePrediction(text) {
  let m;
  if ((m = RE_SIMPLE.exec(text))) return { form: 'metric', metric: m[1], op: m[2], value: Number(m[3]), hours: Number(m[4]) };
  if ((m = RE_BETWEEN.exec(text))) return { form: 'metric', metric: m[1], op: 'between', value: Number(m[2]), value2: Number(m[3]), hours: Number(m[4]) };
  if ((m = RE_ISSUE.exec(text))) return { form: 'issue', issue: m[1], op: 'closed', hours: Number(m[2]) };
  return null;
}

function holds(p, observed) {
  if (observed === null || observed === undefined) return false;
  return p.op === 'between' ? observed >= p.value && observed <= p.value2 : compare(p.op, observed, p.value);
}

async function guardMetrics(db, programId) {
  return all(db, `SELECT * FROM kernel_metrics WHERE kind = 'guard' AND (program_id = ? OR program_id IS NULL)`, programId ?? null);
}

// US-05-R06: stored with prediction, authority and revert path before anything executes.
export async function recordDecision(db, d) {
  const now = d.now ?? Date.now();
  for (const f of ['id', 'decision', 'authority', 'revert_path', 'prediction']) {
    if (!d[f] || !String(d[f]).trim()) throw new Error(`decision requires ${f}`);
  }
  const p = parsePrediction(d.prediction);
  if (!p) throw new Error('prediction is not parsable');
  const kind = d.kind || 'change';
  let baseline = null; const guards = {};
  if (kind === 'change' && p.form === 'metric') {
    if (!(await first(db, `SELECT 1 AS x FROM kernel_metrics WHERE id = ?`, p.metric))) throw new Error(`prediction names unknown metric ${p.metric}`);
    baseline = (await readMetric(db, p.metric, now)).value;
    for (const g of await guardMetrics(db, d.program_id)) guards[g.id] = (await readMetric(db, g.id, now)).value;
  }
  await run(db, `INSERT INTO kernel_decisions (id, program_id, kind, decision, authority, prediction, metric_id, op, target, target2, window_h, due_at,
      baseline, guard_baselines, revert_path, decided_at, item_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    d.id, d.program_id ?? null, kind, d.decision, d.authority, d.prediction, p.metric ?? p.issue, p.op, p.value ?? null, p.value2 ?? null, p.hours,
    iso(now + p.hours * 3600e3), baseline, JSON.stringify(guards), d.revert_path, iso(now), d.item_id ?? null);
  return { id: d.id, prediction: p };
}

// The three numbers US-05-R08 asks to publish.
export async function decisionHealth(db, now = Date.now()) {
  const since = iso(now - 7 * 86400e3);
  const total = (await first(db, `SELECT COUNT(*) AS n FROM kernel_decisions WHERE decided_at >= ?`, since)).n;
  const parsable = (await first(db, `SELECT COUNT(*) AS n FROM kernel_decisions WHERE decided_at >= ? AND metric_id IS NOT NULL`, since)).n;
  const scored = (await first(db, `SELECT COUNT(*) AS n FROM kernel_decisions WHERE evaluated_at >= ? AND status IN ('kept','scored','reverted')`, since)).n;
  const missed = (await first(db, `SELECT COUNT(*) AS n FROM kernel_decisions WHERE evaluated_at >= ? AND status = 'reverted'`, since)).n;
  const overdue = (await first(db, `SELECT COUNT(*) AS n FROM kernel_decisions WHERE status = 'open' AND due_at <= ?`, iso(now))).n;
  return { parsable_share_7d: total ? parsable / total : null, miss_rate_7d: scored ? missed / scored : null, unscored_overdue: overdue };
}

// Evaluate a decision whose window has ended.
export async function evaluateDecision(db, id, { now = Date.now(), guard_tolerance = 0 } = {}) {
  const d = await first(db, `SELECT * FROM kernel_decisions WHERE id = ?`, id);
  if (!d) throw new Error(`unknown decision ${id}`);
  if (d.status !== 'open') return { id, status: d.status };
  if (parseIso(d.due_at) > now) return { id, status: 'open', pending: true };
  const nowIso = iso(now);
  const p = parsePrediction(d.prediction);

  if (p.form === 'issue') {
    const it = await first(db, `SELECT status FROM items WHERE id = ?`, p.issue);
    const ok = it && it.status === 'done';
    await run(db, `UPDATE kernel_decisions SET status='scored', outcome=?, evaluated_at=? WHERE id=?`, ok ? 'matched' : 'missed', nowIso, id);
    return { id, status: 'scored', matched: Boolean(ok) };
  }

  const observed = (await readMetric(db, d.metric_id, now)).value;
  const matched = holds({ op: d.op, value: d.target, value2: d.target2 }, observed);
  if (d.kind === 'allocation') {
    await run(db, `UPDATE kernel_decisions SET status='scored', outcome=?, observed=?, evaluated_at=? WHERE id=?`, matched ? 'matched' : 'missed', observed, nowIso, id);
    return { id, status: 'scored', matched, observed };
  }

  // Guard check: every guard metric must be measured, on target and not worse than at decision time.
  const baselines = JSON.parse(d.guard_baselines || '{}');
  const blocked = [];
  for (const g of await guardMetrics(db, d.program_id)) {
    const cur = (await readMetric(db, g.id, now)).value;
    const st = await first(db, `SELECT state FROM kernel_v_metric_trigger_state WHERE id = ?`, g.id);
    const worse = improvement(g.op, g.target, baselines[g.id] ?? null, cur);
    if (cur === null || st.state !== 'on_target' || (worse !== null && worse < -guard_tolerance)) blocked.push(g.id);
  }
  let status, outcome;
  if (observed === null) { status = 'unmeasured'; outcome = 'unmeasured: a missing reading is not a pass'; }
  else if (matched && blocked.length === 0) { status = 'kept'; outcome = 'kept'; }
  else { status = 'reverted'; outcome = blocked.length && matched ? `blocked_by_guard: ${blocked.join(',')}` : blocked.length ? `missed and guard: ${blocked.join(',')}` : 'missed'; }

  let itemId = null;
  if (status === 'reverted') {
    itemId = `REVERT-${id}`;
    await ensureItem(db, {
      id: itemId, title: `Revert decision ${id}: ${outcome}`, owner_role: 'operations', priority: blocked.length ? 0 : 5,
      done_check: `revert applied via: ${d.revert_path}`, closing_probe: `metric ${d.metric_id} back near ${d.baseline}`, project: d.program_id,
    });
  }
  await run(db, `UPDATE kernel_decisions SET status=?, outcome=?, observed=?, evaluated_at=?, item_id=COALESCE(?, item_id) WHERE id=?`, status, outcome, observed, nowIso, itemId, id);
  return { id, status, outcome, observed, blocked, item_id: itemId };
}

export async function evaluateDueDecisions(db, now = Date.now(), opts = {}) {
  const due = await all(db, `SELECT id FROM kernel_decisions WHERE status = 'open' AND due_at <= ?`, iso(now));
  const out = [];
  for (const d of due) out.push(await evaluateDecision(db, d.id, { now, ...opts }));
  return out;
}
