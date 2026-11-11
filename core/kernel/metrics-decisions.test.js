// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { kdb, setv, probe, HOUR, one, rows } from './testkit.js';
import { registerMetric, readMetric, readAllMetrics, metricsInBreach } from './metrics.js';
import { parsePrediction, recordDecision, evaluateDecision, decisionHealth } from './decisions.js';

const NOW = () => Date.now();

test('trigger state is computed by the view, never stored (US-03, US-05)', async () => {
  const db = kdb();
  assert.equal(rows(db, `PRAGMA table_info(kernel_metrics)`).some(c => /state|verdict|hit/.test(c.name)), false);
  await registerMetric(db, { id: 'usage', op: '>=', target: 10, read_probe: probe('usage') });
  await registerMetric(db, { id: 'errs', kind: 'guard', op: '<=', target: 1, read_probe: probe('errs') });
  await registerMetric(db, { id: 'ghost', op: '>=', target: 1, read_probe: probe('ghost') });
  setv(db, 'usage', 12); setv(db, 'errs', 3);
  await readAllMetrics(db, NOW());
  const st = Object.fromEntries(rows(db, `SELECT id, state, hit FROM kernel_v_metric_trigger_state`).map(r => [r.id, r]));
  assert.equal(st.usage.state, 'on_target'); assert.equal(st.usage.hit, 0);
  assert.equal(st.errs.state, 'breach'); assert.equal(st.errs.hit, 1);
  assert.equal(st.ghost.state, 'unmeasured'); assert.equal(st.ghost.hit, 0);
  assert.equal(await metricsInBreach(db), 1);
  setv(db, 'errs', 0); await readMetric(db, 'errs', NOW());
  assert.equal(await metricsInBreach(db), 0, 'the state follows the data with no stored verdict to update');
});

test('a missing or stale reading is unmeasured (null), never 0 and never a pass (US-04-R09)', async () => {
  const db = kdb();
  await registerMetric(db, { id: 'm', op: '<=', target: 5, read_probe: probe('nothing'), max_age_h: 1 });
  const r = await readMetric(db, 'm', NOW());
  assert.equal(r.value, null);
  assert.equal(one(db, `SELECT value FROM kernel_metric_readings`).value, null);
  setv(db, 'x', 1);
  await registerMetric(db, { id: 'old', op: '<=', target: 5, read_probe: probe('x'), max_age_h: 1 });
  await readMetric(db, 'old', NOW() - 3 * HOUR);
  assert.equal(one(db, `SELECT state FROM kernel_v_metric_trigger_state WHERE id='old'`).state, 'unmeasured');
});

test('a probe must be one read-only SELECT', async () => {
  const db = kdb();
  await assert.rejects(registerMetric(db, { id: 'bad', op: '>=', target: 1, read_probe: 'DELETE FROM items' }), /SELECT/);
  await assert.rejects(registerMetric(db, { id: 'bad', op: '>=', target: 1, read_probe: 'SELECT 1; DROP TABLE items' }), /single/);
});

test('parsable prediction forms (US-05-R07, US-05-T03)', () => {
  assert.deepEqual(parsePrediction('queue_depth <= 5 within 24 h'), { form: 'metric', metric: 'queue_depth', op: '<=', value: 5, hours: 24 });
  assert.deepEqual(parsePrediction('x between 1 and 3 within 2 h'), { form: 'metric', metric: 'x', op: 'between', value: 1, value2: 3, hours: 2 });
  assert.deepEqual(parsePrediction('issue ABC-1 closed within 48 h'), { form: 'issue', issue: 'ABC-1', op: 'closed', hours: 48 });
  assert.equal(parsePrediction('it will probably get better'), null);
});

test('a decision is stored with prediction, authority and revert path before it runs (US-05-R06)', async () => {
  const db = kdb();
  await registerMetric(db, { id: 'usage', op: '>=', target: 1, read_probe: probe('usage') });
  setv(db, 'usage', 100);
  const base = { id: 'D1', decision: 'add a summary', authority: 'program-manager within charter', prediction: 'usage >= 110 within 24 h', revert_path: 'revert PR 12' };
  for (const f of ['authority', 'revert_path', 'decision']) await assert.rejects(recordDecision(db, { ...base, [f]: '' }), new RegExp(f));
  await assert.rejects(recordDecision(db, { ...base, prediction: 'better soon' }), /parsable/);
  await assert.rejects(recordDecision(db, { ...base, prediction: 'nope >= 1 within 1 h' }), /unknown metric/);
  await recordDecision(db, base);
  const d = one(db, `SELECT * FROM kernel_decisions WHERE id='D1'`);
  assert.equal(d.op, '>='); assert.equal(d.target, 110); assert.equal(d.baseline, 100); assert.ok(d.due_at > d.decided_at);
});

async function scenario({ usage = 120, errsBefore = 1, errsAfter = 1, guardMax = 5 }) {
  const db = kdb();
  await registerMetric(db, { id: 'usage', program_id: 'P', op: '>=', target: 1, read_probe: probe('usage') });
  await registerMetric(db, { id: 'errs', program_id: 'P', kind: 'guard', op: '<=', target: guardMax, read_probe: probe('errs') });
  setv(db, 'usage', 100); setv(db, 'errs', errsBefore);
  const then = NOW() - 48 * HOUR;
  await recordDecision(db, { id: 'D', program_id: 'P', decision: 'plus', authority: 'pm', prediction: 'usage >= 110 within 24 h', revert_path: 'git revert', now: then });
  setv(db, 'usage', usage); setv(db, 'errs', errsAfter);
  return { db, res: await evaluateDecision(db, 'D', { now: NOW() }) };
}

test('a target gain with every guard intact is kept', async () => {
  const { res } = await scenario({});
  assert.equal(res.status, 'kept');
});

test('a breached guard metric blocks a target-metric gain from being kept (conformance)', async () => {
  const { db, res } = await scenario({ usage: 140, errsAfter: 9 });
  assert.equal(res.status, 'reverted');
  assert.match(res.outcome, /blocked_by_guard: errs/);
  const it = one(db, `SELECT * FROM items WHERE id='REVERT-D'`);
  assert.ok(it); assert.equal(it.priority, 0); assert.match(it.done_check, /git revert/);
});

test('a guard that worsened but is still on target also blocks the gain', async () => {
  const { res } = await scenario({ usage: 140, errsBefore: 1, errsAfter: 4, guardMax: 5 });
  assert.equal(res.status, 'reverted');
});

test('a missed prediction is reverted; an unmeasured target is not kept', async () => {
  const miss = await scenario({ usage: 100 });
  assert.equal(miss.res.status, 'reverted');
  const db = kdb();
  await registerMetric(db, { id: 'u', op: '>=', target: 1, read_probe: probe('u') });
  setv(db, 'u', 1);
  await recordDecision(db, { id: 'D', decision: 'x', authority: 'a', prediction: 'u >= 2 within 1 h', revert_path: 'r', now: NOW() - 5 * HOUR });
  db.raw.exec(`DELETE FROM t_vals`);
  const r = await evaluateDecision(db, 'D', { now: NOW() });
  assert.equal(r.status, 'unmeasured');
});

test('a decision is not evaluated before its window ends; health numbers are published (US-05-R08)', async () => {
  const db = kdb();
  await registerMetric(db, { id: 'u', op: '>=', target: 1, read_probe: probe('u') });
  setv(db, 'u', 1);
  await recordDecision(db, { id: 'D', decision: 'x', authority: 'a', prediction: 'u >= 2 within 24 h', revert_path: 'r', now: NOW() });
  assert.equal((await evaluateDecision(db, 'D', { now: NOW() })).pending, true);
  await recordDecision(db, { id: 'OLD', decision: 'y', authority: 'a', prediction: 'u >= 2 within 1 h', revert_path: 'r', now: NOW() - 3 * HOUR });
  const h = await decisionHealth(db, NOW());
  assert.equal(h.unscored_overdue, 1); assert.equal(h.parsable_share_7d, 1);
});
