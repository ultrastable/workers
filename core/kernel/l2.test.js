// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runTick, STEP_ORDER } from '../src/tick.js';
import { kdb, setv, probe, item, one, rows } from './testkit.js';
import { registerMetric } from './metrics.js';
import { registerProgram } from './programs.js';
import { registerFailureMode } from './failure.js';
import { runL2, L2_EXTRA_STEPS, L2_STEP_NAMES } from './index.js';

const policy = JSON.parse(readFileSync(new URL('../../autonomy/policy.json', import.meta.url), 'utf8'));
const config = { org_slug: 't', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy };

test('the tick extension hook is backward compatible: no extraSteps means the seven L1 steps', async () => {
  const db = kdb();
  const r = await runTick(db, { config });
  assert.equal(r.total, STEP_ORDER.length); assert.equal(r.completed, STEP_ORDER.length);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM kernel_step_evidence`).n, 0);
});

test('runL2 plugs into runTick as an extra step and every sub-step writes an evidence row (US-03-R11)', async () => {
  const db = kdb();
  await registerProgram(db, { id: 'P', name: 'p', primary_metric_id: 'm' });
  await registerMetric(db, { id: 'm', program_id: 'P', op: '>=', target: 1, read_probe: probe('m') });
  setv(db, 'm', 2); item(db, 'I1', { project: 'P' });
  const r = await runTick(db, { config, extraSteps: L2_EXTRA_STEPS });
  assert.equal(r.total, STEP_ORDER.length + 1); assert.equal(r.completed, r.total); assert.deepEqual(r.errors, []);
  assert.match(r.report, /l2 9\/9/);
  const ev = rows(db, `SELECT step, ok FROM kernel_step_evidence WHERE tick_id = ?`, r.tickId);
  assert.deepEqual(ev.map(e => e.step).sort(), [...L2_STEP_NAMES].sort());
  assert.ok(ev.every(e => e.ok === 1));
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM kernel_allocations`).n, 1);
  assert.equal(one(db, `SELECT status FROM kernel_decisions WHERE id = ?`, `ALLOC-${r.tickId}`).status, 'open');
});

test('a failing L2 sub-step is guarded: the rest run, a TICKFAIL item is filed and the error is reported', async () => {
  const db = kdb();
  db.raw.exec(`DROP TABLE kernel_failure_modes`);
  const r = await runTick(db, { config, extraSteps: L2_EXTRA_STEPS });
  assert.equal(r.completed, r.total, 'the tick itself still completes');
  assert.ok(r.errors.some(e => /detectors/.test(e)));
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM items WHERE id LIKE 'TICKFAIL-l2_detectors-%' AND priority = 0`).n, 1);
  const ev = rows(db, `SELECT step, ok FROM kernel_step_evidence`);
  assert.equal(ev.length, L2_STEP_NAMES.length); assert.equal(ev.filter(e => e.ok === 0).length, 1);
});

test('a previous slot with missing evidence rows is detected as a failure (US-03-R11)', async () => {
  const db = kdb();
  const t1 = await runTick(db, { config, extraSteps: L2_EXTRA_STEPS });
  db.raw.prepare(`DELETE FROM kernel_step_evidence WHERE tick_id = ? AND step IN ('focus', 'lifecycle')`).run(t1.tickId);
  const t2 = await runTick(db, { config, extraSteps: L2_EXTRA_STEPS });
  const it = one(db, `SELECT title FROM items WHERE id = ?`, `L2MISSING-${t1.tickId}`);
  assert.match(it.title, /focus, lifecycle/);
  assert.equal(t2.completed, t2.total);
});

test('end to end: a detector fires, a remediation item is filed and closed by its probe, all through the tick', async () => {
  const db = kdb(); setv(db, 'seen', 1); setv(db, 'queue_err', 3);
  await registerFailureMode(db, {
    id: 'FM-A', severity: 3, detector_sql: `SELECT v AS value FROM t_vals WHERE k = 'seen'`, fire_when: 'value < 5',
    contract: { owner: 'ops', doer: 'fixer', closing_probe: probe('queue_err'), pass: '= 0', max_attempts: 3, backoff_h: [0], deadline_h: 24 },
  });
  const t1 = await runTick(db, { config, extraSteps: L2_EXTRA_STEPS });
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM kernel_remediations WHERE status='open'`).n, 1);
  setv(db, 'queue_err', 0); setv(db, 'seen', 10);
  const t2 = await runTick(db, { config, extraSteps: L2_EXTRA_STEPS, now: Date.now() + 60e3 });
  assert.equal(one(db, `SELECT status FROM kernel_remediations`).status, 'closed');
  assert.equal(t2.tickId, t1.tickId + 1);
});

test('runL2 can be called directly with a context object', async () => {
  const db = kdb();
  const ctx = { config: {}, now: Date.now(), tickId: 1, notes: [], errors: [] };
  const r = await runL2(db, ctx);
  assert.equal(r.completed, L2_STEP_NAMES.length); assert.deepEqual(r.errors, []);
});
