// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The L2 managerial layer. Plug into the seed tick: runTick(db, { config, extraSteps: L2_EXTRA_STEPS }).
import { fileURLToPath } from 'node:url';
import { all, first, run, iso, ensureItem } from './util.js';
import { readAllMetrics } from './metrics.js';
import { evaluateDueDecisions } from './decisions.js';
import { snapshotRisk, allocate, setFocus } from './programs.js';
import { runDetectors, detectStaleDetectors, reviewProbation, consumeRemediations, judgeRemedies } from './failure.js';
import { lifecycleGaps } from './lifecycle.js';

export * from './metrics.js';
export * from './decisions.js';
export * from './programs.js';
export * from './failure.js';
export * from './lifecycle.js';
export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

// Measurement steps always run; manager operations stop when config.kernel.manager_ops === false (US-03-R14).
export const L2_STEPS = [
  { name: 'read_metrics', ops: false, fn: async (db, c) => `${(await readAllMetrics(db, c.now)).length} metric(s) read` },
  { name: 'risk_snapshot', ops: false, fn: async (db, c) => `${(await snapshotRisk(db, { tickId: c.tickId, now: c.now, config: c.k })).length} program(s)` },
  { name: 'detectors', ops: false, fn: async (db, c) => {
    const f = await runDetectors(db, { now: c.now }); const s = await detectStaleDetectors(db, { now: c.now }); await reviewProbation(db);
    return `${f.length} fired, ${s.length} stale`; } },
  { name: 'allocate', ops: true, fn: async (db, c) => { const a = await allocate(db, { tickId: c.tickId, now: c.now, config: c.k }); return `${Object.keys(a).length} program(s) allocated`; } },
  { name: 'focus', ops: true, fn: async (db, c) => `${Object.keys(await setFocus(db, { tickId: c.tickId, now: c.now, config: c.k })).length} program(s) focused` },
  { name: 'decisions', ops: true, fn: async (db, c) => `${(await evaluateDueDecisions(db, c.now)).length} decision(s) evaluated` },
  { name: 'remedies', ops: true, fn: async (db, c) => `${(await judgeRemedies(db, { now: c.now })).length} remedy(ies) judged` },
  { name: 'remediate', ops: true, fn: async (db, c) => { const r = await consumeRemediations(db, { now: c.now, invokeDoer: c.invokeDoer }); return `scanned ${r.scanned}`; } },
  { name: 'lifecycle', ops: true, fn: async (db, c) => `${(await lifecycleGaps(db)).length} gate item(s) filed` },
];
export const L2_STEP_NAMES = L2_STEPS.map(s => s.name);

// US-03-R11: every sub-step writes an evidence row; a previous L2 slot with missing rows is filed as a failure.
async function checkPreviousSlot(db, c) {
  const prev = c.tickId - 1;
  const seen = (await all(db, `SELECT DISTINCT step FROM kernel_step_evidence WHERE tick_id = ?`, prev)).map(r => r.step);
  const tr = await first(db, `SELECT steps_total FROM tick_runs WHERE id = ?`, prev);
  if (!tr || (seen.length === 0 && tr.steps_total <= 7)) return; // that tick ran without L2
  const missing = L2_STEP_NAMES.filter(n => !seen.includes(n));
  if (missing.length) await ensureItem(db, { id: `L2MISSING-${prev}`, title: `Tick ${prev} left no evidence for: ${missing.join(', ')}`, owner_role: 'operations', priority: 0, done_check: 'next tick writes evidence for every L2 step' });
}

export async function runL2(db, ctx) {
  const c = { ...ctx, k: ctx.config?.kernel || {} };
  if (c.k.enabled === false) { ctx.notes?.push('l2 disabled'); return { completed: 0, total: 0, errors: [] }; }
  const errors = [];
  let completed = 0;
  try { await checkPreviousSlot(db, c); } catch (e) { errors.push(`slot_check: ${e.message}`); }
  for (const s of L2_STEPS) {
    if (s.ops && c.k.manager_ops === false) { await evidence(db, c, s.name, 1, 'skipped: manager_ops off'); continue; }
    try { const ev = await s.fn(db, c); await evidence(db, c, s.name, 1, ev); completed++; }
    catch (e) {
      errors.push(`${s.name}: ${e.message}`);
      try { await evidence(db, c, s.name, 0, e.message);
        await ensureItem(db, { id: `TICKFAIL-l2_${s.name}-${iso(c.now).slice(0, 13).replace(/[- :]/g, '')}`, title: `L2 step ${s.name} failed: ${e.message}`, owner_role: 'operations', priority: 0, done_check: `next tick completes l2 step ${s.name}` });
      } catch { /* store down; the error is returned below */ }
    }
  }
  ctx.notes?.push(`l2 ${completed}/${L2_STEPS.length}`);
  if (errors.length) ctx.errors?.push(...errors.map(e => `l2 ${e}`));
  return { completed, total: L2_STEPS.length, errors };
}
async function evidence(db, c, step, ok, text) {
  await run(db, `INSERT INTO kernel_step_evidence (tick_id, step, ok, evidence, at) VALUES (?,?,?,?,?)`, c.tickId, step, ok, String(text).slice(0, 500), iso(c.now));
}

export const L2_EXTRA_STEPS = [{ name: 'l2', run: runL2 }];
