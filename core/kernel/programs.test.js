// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { kdb, setv, probe, item, one, rows } from './testkit.js';
import { registerMetric, readAllMetrics } from './metrics.js';
import { registerProgram, riskScore, snapshotRisk, allocateSlots, allocate, setFocus } from './programs.js';
import { parsePrediction } from './decisions.js';
import { runL2 } from './index.js';

const progs = (risks, extra = {}) => risks.map((risk, i) => ({ id: `p${i}`, risk, open: 1, ...(extra[i] || {}) }));
const slotsOf = (o, n) => Array.from({ length: n }, (_, i) => o[`p${i}`].slots);

test('US-03-T06: risks 120/40/20/15/5 with T=25 allocate 10/5/4/3/3 and OPS constrains', () => {
  const a = allocateSlots(progs([120, 40, 20, 15, 5]), 25);
  assert.deepEqual(slotsOf(a, 5), [10, 5, 4, 3, 3]);
  assert.equal(a.p0.class, 'constrain');
});

test('an escalated program gets 1.5x slots and the total stays at T (worked example)', () => {
  const a = allocateSlots(progs([120, 40, 20, 15, 5], { 1: { escalate: true } }), 25);
  assert.equal(a.p1.slots, 7); assert.equal(a.p1.class, 'escalate');
  assert.equal(slotsOf(a, 5).reduce((s, n) => s + n, 0), 25);
  assert.ok(a.p4.slots < 3, 'the excess came off the lowest-risk program');
});

test('allocation never exceeds T and idle programs get none (US-03-R13)', () => {
  for (const T of [1, 7, 25, 40]) for (const risks of [[1, 1, 1], [0, 0, 0], [100, 1], [3, 9, 27, 81, 243]]) {
    const a = allocateSlots(progs(risks, { 0: { escalate: true } }), T);
    assert.ok(slotsOf(a, risks.length).reduce((s, n) => s + n, 0) <= T, `T=${T} risks=${risks}`);
  }
  const a = allocateSlots([{ id: 'a', risk: 5, open: 1 }, { id: 'b', risk: 50, open: 0 }], 25);
  assert.equal(a.b.slots, 0); assert.equal(a.b.class, 'idle'); assert.equal(a.a.slots, 25);
});

test('risk = 3H + 0.3O + 15G + 2S', () => assert.equal(riskScore({ high: 2, open: 4, guards: 1, stalled: 1 }), 24.2));

async function world() {
  const db = kdb();
  await registerProgram(db, { id: 'P1', name: 'Reach', primary_metric_id: 'm1' });
  await registerMetric(db, { id: 'm1', program_id: 'P1', op: '>=', target: 10, read_probe: probe('m1') });
  await registerMetric(db, { id: 'g1', program_id: 'P1', kind: 'guard', op: '<=', target: 1, read_probe: probe('g1') });
  setv(db, 'm1', 5); setv(db, 'g1', 3);
  await readAllMetrics(db);
  item(db, 'A', { project: 'P1' }); item(db, 'B', { project: 'P1' }); item(db, 'C', { project: 'P1', priority: 5 });
  item(db, 'D', { project: 'P1' }); item(db, 'E', { project: 'P1', status: 'blocked' });
  db.raw.exec(`UPDATE items SET priority = 1 WHERE id = 'E'`);
  db.raw.exec(`INSERT INTO kernel_item_meta (item_id, metric_id, doer) VALUES ('A','m1','coder'), ('B','m1',NULL)`);
  return db;
}

test('risk snapshot: guard breach makes the program RED and the numbers follow the formula (US-03-R12)', async () => {
  const db = await world();
  const [s] = await snapshotRisk(db, { tickId: 1, now: Date.now() });
  assert.equal(s.verdict, 'RED'); assert.equal(s.guards, 1); assert.equal(s.stalled, 1); assert.equal(s.high, 2);
  assert.equal(s.risk, riskScore({ high: 2, open: 5, guards: 1, stalled: 1 }));
  assert.equal(s.quality_index, 0);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM kernel_risk_snapshot WHERE tick_id=1`).n, 1);
});

test('focus: primary-metric items first, and within a tier the item with no doer ranks first', async () => {
  const db = await world();
  const now = Date.now();
  await snapshotRisk(db, { tickId: 1, now }); await allocate(db, { tickId: 1, now });
  const focus = await setFocus(db, { tickId: 1, now });
  assert.equal(focus.P1[0], 'B'); assert.equal(focus.P1[1], 'A');
  const f = rows(db, `SELECT item_id, tier, has_doer FROM kernel_focus ORDER BY rank`);
  assert.equal(f[0].tier, 0); assert.equal(f[0].has_doer, 0); assert.equal(f[1].has_doer, 1);
  assert.equal(f[2].item_id, 'E'); assert.equal(f[2].tier, 3);
  assert.deepEqual(focus.P1, ['B', 'A', 'E', 'C', 'D']);
});

test('every allocation writes a decision_log row with a parsable prediction (US-03-R15)', async () => {
  const db = await world();
  const now = Date.now();
  await snapshotRisk(db, { tickId: 7, now }); await allocate(db, { tickId: 7, now });
  const d = one(db, `SELECT * FROM kernel_decisions WHERE id='ALLOC-7'`);
  assert.ok(d); assert.ok(d.authority); assert.ok(d.revert_path); assert.ok(parsePrediction(d.prediction));
  assert.equal(one(db, `SELECT slots FROM kernel_allocations WHERE tick_id=7`).slots, 25);
});

test('manager operations can be switched off while measurement continues (US-03-R14)', async () => {
  const db = await world();
  const ctx = { config: { kernel: { manager_ops: false } }, now: Date.now(), tickId: 3, notes: [], errors: [] };
  await runL2(db, ctx);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM kernel_risk_snapshot`).n, 1, 'risk is still measured');
  assert.ok(one(db, `SELECT COUNT(*) AS n FROM kernel_metric_readings`).n >= 2);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM kernel_allocations`).n, 0, 'no allocation was made');
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM kernel_focus`).n, 0);
  const off = { ...ctx, tickId: 4, config: { kernel: { enabled: false } }, notes: [] };
  await runL2(db, off);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM kernel_step_evidence WHERE tick_id=4`).n, 0);
});
