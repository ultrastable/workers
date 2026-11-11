// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Program charters, risk snapshot, slot allocation and focus (US-SPEC-03 s4, US-03-R12/R13/R15).
import { all, first, run, iso, TERMINAL_SQL } from './util.js';
import { registerMetric } from './metrics.js';
import { recordDecision } from './decisions.js';

export async function registerProgram(db, p) {
  if (!p.id || !p.name) throw new Error('program id and name required');
  await run(db, `INSERT INTO kernel_programs (id, name, objective, primary_metric_id, cost_cap, owner_role, status) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, objective=excluded.objective, primary_metric_id=excluded.primary_metric_id,
        cost_cap=excluded.cost_cap, owner_role=excluded.owner_role, status=excluded.status`,
    p.id, p.name, p.objective ?? null, p.primary_metric_id ?? null, p.cost_cap ?? null, p.owner_role ?? null, p.status || 'active');
}

const SCOPE = `(i.project = ? OR i.project IN (SELECT id FROM kernel_projects WHERE program_id = ?))`;
const ACTIVE = `i.status NOT IN ${TERMINAL_SQL}`;

// risk = 3H + 0.3O + 15G + 2S. H open high-priority items, O open items, G guard breaches, S stalled (blocked) items.
export function riskScore({ high, open, guards, stalled }) { return 3 * high + 0.3 * open + 15 * guards + 2 * stalled; }

// US-03-R12: computed once per tick, written to a snapshot that later steps read.
export async function snapshotRisk(db, { tickId, now, config = {} }) {
  const highMax = config.high_priority_max ?? 10;
  const rows = [];
  for (const p of await all(db, `SELECT * FROM kernel_programs WHERE status = 'active' ORDER BY id`)) {
    const high = (await first(db, `SELECT COUNT(*) AS n FROM items i WHERE ${ACTIVE} AND i.priority <= ? AND ${SCOPE}`, highMax, p.id, p.id)).n;
    const open = (await first(db, `SELECT COUNT(*) AS n FROM items i WHERE ${ACTIVE} AND ${SCOPE}`, p.id, p.id)).n;
    const stalled = (await first(db, `SELECT COUNT(*) AS n FROM items i WHERE i.status = 'blocked' AND ${SCOPE}`, p.id, p.id)).n;
    const guards = (await first(db, `SELECT COUNT(*) AS n FROM kernel_v_metric_trigger_state WHERE kind = 'guard' AND hit = 1 AND (program_id = ?)`, p.id)).n;
    const mets = await all(db, `SELECT id, state, hit FROM kernel_v_metric_trigger_state WHERE program_id = ?`, p.id);
    const primaryBreach = p.primary_metric_id ? mets.some(m => m.id === p.primary_metric_id && m.hit === 1) : false;
    const verdict = guards > 0 || primaryBreach ? 'RED' : high > 0 || stalled > 0 ? 'AMBER' : 'GREEN';
    const quality = mets.length ? (100 * mets.filter(m => m.state === 'on_target').length) / mets.length : null;
    const risk = riskScore({ high, open, guards, stalled });
    await run(db, `INSERT INTO kernel_risk_snapshot (tick_id, program_id, high, open_items, guard_breaches, stalled, risk, verdict, quality_index, at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, tickId, p.id, high, open, guards, stalled, risk, verdict, quality, iso(now));
    rows.push({ program_id: p.id, high, open, guards, stalled, risk, verdict, quality_index: quality });
  }
  return rows;
}

// Pure allocation (US-03-T06). programs: [{id, risk, open, escalate?, accelerate?, green?}]. Total never exceeds T (US-03-R13).
// Half of T (rounded down) is split evenly among programs with open work, the rest in proportion to risk; largest remainder
// rounding. An escalated program gets one and a half times its slots, taken from the lowest-risk programs.
export function allocateSlots(programs, T = 25) {
  const live = programs.filter(p => p.open > 0);
  const out = Object.fromEntries(programs.map(p => [p.id, { slots: 0, class: 'idle' }]));
  if (!live.length) return out;
  const totalRisk = live.reduce((s, p) => s + p.risk, 0);
  const even = totalRisk > 0 ? Math.floor(T / 2) : T;
  const raw = live.map(p => ({ p, v: even / live.length + (totalRisk > 0 ? (T - even) * p.risk / totalRisk : 0) }));
  raw.forEach(r => { r.n = Math.floor(r.v + 1e-9); r.f = r.v - r.n; });
  let left = T - raw.reduce((s, r) => s + r.n, 0);
  for (const r of [...raw].sort((a, b) => b.f - a.f || b.p.risk - a.p.risk || a.p.id.localeCompare(b.p.id))) { if (left <= 0) break; r.n++; left--; }
  const maxRisk = Math.max(...live.map(p => p.risk));
  for (const r of raw) {
    const p = r.p; let cls = 'steady';
    if (p.escalate) { r.n = Math.floor(r.n * 1.5); cls = 'escalate'; }
    else if (p.accelerate) cls = 'accelerate';
    else if (p.green) cls = 'maintain';
    if (p.risk === maxRisk && maxRisk > 0) cls = 'constrain';
    out[p.id] = { slots: r.n, class: cls };
  }
  let total = raw.reduce((s, r) => s + r.n, 0);
  const asc = [...raw].sort((a, b) => a.p.risk - b.p.risk || a.p.id.localeCompare(b.p.id));
  while (total > T) {
    const victim = asc.find(r => !r.p.escalate && out[r.p.id].slots > 1) || asc.find(r => out[r.p.id].slots > 0);
    out[victim.p.id].slots--; total--;
  }
  return out;
}

export async function ensureAllocationMetric(db) {
  await registerMetric(db, {
    id: 'program_focus_without_doer', kind: 'target', op: '<=', target: 0, max_age_h: 48,
    read_probe: `SELECT COUNT(*) AS value FROM kernel_focus WHERE has_doer = 0`,
    description: 'Focus items that have no doer',
  });
}

// Steps 306/308: allocate slots, classify, and log the decision with a parsable prediction (US-03-R15).
export async function allocate(db, { tickId, now, config = {} }) {
  const T = config.slots ?? 25;
  const snaps = await all(db, `SELECT * FROM kernel_risk_snapshot WHERE tick_id = ?`, tickId);
  if (!snaps.length) return {};
  const windowStart = iso(now - 24 * 3600e3);
  const inputs = [];
  for (const s of snaps) {
    const prev = await first(db, `SELECT risk, quality_index FROM kernel_risk_snapshot WHERE program_id = ? AND tick_id <> ? AND at >= ? ORDER BY at LIMIT 1`, s.program_id, tickId, windowStart);
    const riskUp = prev && prev.risk > 0 ? (s.risk - prev.risk) / prev.risk : 0;
    const qualDown = prev && prev.quality_index !== null && s.quality_index !== null ? prev.quality_index - s.quality_index : 0;
    inputs.push({
      id: s.program_id, risk: s.risk, open: s.open_items, green: s.verdict === 'GREEN',
      escalate: riskUp > 0.10 || qualDown >= 5, accelerate: prev && prev.risk > 0 && riskUp < -0.20,
    });
  }
  const alloc = allocateSlots(inputs, T);
  for (const i of inputs) {
    await run(db, `INSERT INTO kernel_allocations (tick_id, program_id, slots, class, risk, at) VALUES (?,?,?,?,?,?)`, tickId, i.id, alloc[i.id].slots, alloc[i.id].class, i.risk, iso(now));
  }
  await ensureAllocationMetric(db);
  const gap = (await first(db, `SELECT COUNT(*) AS n FROM kernel_focus WHERE has_doer = 0`)).n;
  await recordDecision(db, {
    id: `ALLOC-${tickId}`, kind: 'allocation', decision: `allocate ${T} slots: ${inputs.map(i => `${i.id}=${alloc[i.id].slots}`).join(' ')}`,
    authority: 'portfolio-manager allocation rule (US-SPEC-03 s4)', prediction: `program_focus_without_doer <= ${gap} within 24 h`,
    revert_path: 'set kernel.manager_ops=false; the previous tick allocation row stays in kernel_allocations', now,
  });
  return alloc;
}

// Step 310: tier 0 serves the charter's primary metric, 1 a guard metric, 2 critical, 3 high, 4 other.
// Within a tier, items with no doer rank first, then priority, then age.
export async function setFocus(db, { tickId, now, config = {} }) {
  const highMax = config.high_priority_max ?? 10;
  const allocs = await all(db, `SELECT * FROM kernel_allocations WHERE tick_id = ? AND slots > 0`, tickId);
  const result = {};
  for (const a of allocs) {
    const prog = await first(db, `SELECT * FROM kernel_programs WHERE id = ?`, a.program_id);
    const guardIds = (await all(db, `SELECT id FROM kernel_metrics WHERE kind = 'guard' AND program_id = ?`, a.program_id)).map(r => r.id);
    const items = await all(db, `SELECT i.id, i.priority, i.created_at, i.status, m.metric_id, m.doer, m.critical,
          (SELECT COUNT(*) FROM claims c WHERE c.item_id = i.id) AS claimed
        FROM items i LEFT JOIN kernel_item_meta m ON m.item_id = i.id WHERE ${ACTIVE} AND ${SCOPE}`, a.program_id, a.program_id);
    const ranked = items.map(i => {
      const tier = prog.primary_metric_id && i.metric_id === prog.primary_metric_id ? 0 : i.metric_id && guardIds.includes(i.metric_id) ? 1
        : i.critical || i.priority <= 0 ? 2 : i.priority <= highMax ? 3 : 4;
      return { ...i, tier, has_doer: i.doer || i.claimed ? 1 : 0 };
    }).sort((x, y) => x.tier - y.tier || x.has_doer - y.has_doer || x.priority - y.priority || String(x.created_at).localeCompare(String(y.created_at)) || x.id.localeCompare(y.id));
    await run(db, `DELETE FROM kernel_focus WHERE program_id = ?`, a.program_id);
    ranked.slice(0, a.slots).forEach((i, n) => { result[a.program_id] = result[a.program_id] || []; result[a.program_id].push(i.id); });
    for (const [n, i] of ranked.slice(0, a.slots).entries()) {
      await run(db, `INSERT INTO kernel_focus (program_id, item_id, rank, tier, has_doer, tick_id) VALUES (?,?,?,?,?,?)`, a.program_id, i.id, n + 1, i.tier, i.has_doer, tickId);
    }
  }
  return result;
}
