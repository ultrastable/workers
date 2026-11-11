// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Metric registry and triggers (US-SPEC-03 s4, US-SPEC-05). A metric has a target, a guard flag and a read probe.
// Its trigger state is computed by the view kernel_v_metric_trigger_state, never stored.
import { all, first, run, iso, assertReadOnly } from './util.js';

export async function registerMetric(db, m) {
  if (!m.id) throw new Error('metric id required');
  if (!['target', 'guard'].includes(m.kind || 'target')) throw new Error('kind must be target or guard');
  if (!['>=', '<=', '>', '<', '='].includes(m.op)) throw new Error('unknown operator');
  if (typeof m.target !== 'number') throw new Error('numeric target required');
  assertReadOnly(m.read_probe);
  await run(db, `INSERT INTO kernel_metrics (id, program_id, kind, op, target, read_probe, max_age_h, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET program_id=excluded.program_id, kind=excluded.kind, op=excluded.op, target=excluded.target,
        read_probe=excluded.read_probe, max_age_h=excluded.max_age_h, description=excluded.description`,
    m.id, m.program_id ?? null, m.kind || 'target', m.op, m.target, m.read_probe, m.max_age_h ?? 24, m.description ?? null);
}

// Run the probe and store the reading. A failing or empty probe stores null (unmeasured), never 0 (US-04-R09).
export async function readMetric(db, id, now = Date.now()) {
  const m = await first(db, `SELECT * FROM kernel_metrics WHERE id = ?`, id);
  if (!m) throw new Error(`unknown metric ${id}`);
  let value = null, evidence = null;
  try {
    const row = await first(db, assertReadOnly(m.read_probe));
    const v = row ? (row.value ?? Object.values(row)[0]) : null;
    value = v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);
    if (value === null) evidence = 'probe returned no numeric value';
  } catch (e) { evidence = `probe error: ${e.message}`; }
  await run(db, `INSERT INTO kernel_metric_readings (metric_id, value, read_at, evidence) VALUES (?, ?, ?, ?)`, id, value, iso(now), evidence);
  return { id, value, evidence };
}

export async function readAllMetrics(db, now = Date.now()) {
  const out = [];
  for (const m of await all(db, `SELECT id FROM kernel_metrics ORDER BY id`)) out.push(await readMetric(db, m.id, now));
  return out;
}

export async function triggerStates(db, programId = null) {
  return programId === null
    ? all(db, `SELECT * FROM kernel_v_metric_trigger_state ORDER BY id`)
    : all(db, `SELECT * FROM kernel_v_metric_trigger_state WHERE program_id = ? ORDER BY id`, programId);
}

// Headline measure: how many metrics are in breach right now.
export async function metricsInBreach(db) {
  return (await first(db, `SELECT COUNT(*) AS n FROM kernel_v_metric_trigger_state WHERE hit = 1`)).n;
}
