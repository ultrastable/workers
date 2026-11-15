// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import * as P from './index.js';

const MIG = fileURLToPath(P.MIGRATIONS_DIR);
const NOW = Date.UTC(2026, 10, 11, 10, 0, 0);
const H = 3600e3;
const mk = () => makeDb([MIG]);
const one = (db, sql, ...a) => db.raw.prepare(sql).get(...a);
const item = (db, id, status = 'ready', disposition = null) =>
  db.raw.prepare(`INSERT INTO items (id, title, owner_role, done_check, status, disposition) VALUES (?, ?, 'operations', 'observed', ?, ?)`).run(id, id, status, disposition);

test('migration is idempotent and every table and view is predict_ prefixed', () => {
  const db = mk();
  const sql = readFileSync(MIG + '0001_predict.sql', 'utf8');
  db.raw.exec(sql); db.raw.exec(sql);
  const names = [...sql.matchAll(/CREATE (?:TABLE IF NOT EXISTS|VIEW) (\w+)/g)].map(m => m[1]);
  assert.ok(names.length >= 10);
  for (const n of names) assert.match(n, /^predict_/);
});

test('US-05-R07 parses the three forms of section 3.1 and nothing else', () => {
  assert.deepEqual(P.parsePrediction('queue_depth <= 5 within 24 h'), { form: 'metric', subject: 'queue_depth', op: '<=', value: 5, value2: null, hours: 24 });
  assert.deepEqual(P.parsePrediction('latency_ms between 80 and 120.5 within 6 h'), { form: 'metric', subject: 'latency_ms', op: 'between', value: 80, value2: 120.5, hours: 6 });
  assert.deepEqual(P.parsePrediction('issue FIX-12 closed within 48 h'), { form: 'issue', subject: 'FIX-12', op: 'closed', value: null, value2: null, hours: 48 });
  for (const op of ['<', '<=', '>', '>=', '=']) assert.equal(P.parsePrediction(`m ${op} 1 within 1 h`).op, op);
  for (const bad of ['it will be better', 'm != 3 within 2 h', 'm <= five within 2 h', 'm <= 5', 'm <= 5 within soon', '']) assert.equal(P.parsePrediction(bad), null, bad);
});

test('US-05-T03 the decision text "queue_depth <= 5 within 24 h" becomes a prediction row with op <=, value 5, due 24 h later', async () => {
  const db = mk();
  const r = await P.recordDecision(db, { id: 'D1', decision: 'add a second doer', predicted_outcome: 'queue_depth <= 5 within 24 h', revert_path: 'remove the doer', persona: 'pm-1', action_class: 'assign', surface: 'work_tracker' }, { now: NOW });
  assert.equal(r.parsable, true);
  const p = one(db, `SELECT * FROM predict_predictions WHERE decision_id='D1'`);
  assert.equal(p.subject, 'queue_depth'); assert.equal(p.op, '<='); assert.equal(p.value, 5);
  assert.equal(p.due_at, '2026-11-12 10:00:00'); assert.equal(p.origin, 'parsed'); assert.equal(p.matched, null);
});

test('US-05-R06 a decision without a predicted outcome or revert path is refused and nothing executes; with both, rows exist before execute runs', async () => {
  const db = mk();
  let ran = 0;
  await assert.rejects(P.recordDecision(db, { id: 'D0', decision: 'x', predicted_outcome: 'm >= 1 within 1 h' }, { now: NOW, execute: () => { ran++; } }), /revert_path/);
  await assert.rejects(P.recordDecision(db, { id: 'D0', decision: 'x', revert_path: 'undo' }, { now: NOW, execute: () => { ran++; } }), /predicted_outcome/);
  assert.equal(ran, 0);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM predict_decisions`).n, 0);
  const r = await P.recordDecision(db, { id: 'D2', decision: 'x', predicted_outcome: 'Prediction: m >= 1 within 1 h.', revert_path: 'undo' }, {
    now: NOW, execute: () => ({ decisions: one(db, `SELECT COUNT(*) AS n FROM predict_decisions WHERE id='D2'`).n, predictions: one(db, `SELECT COUNT(*) AS n FROM predict_predictions WHERE decision_id='D2'`).n }),
  });
  assert.deepEqual(r.result, { decisions: 1, predictions: 1 });
});

test('US-05-R01 a prediction without a metric, operator, target or due time is not stored', async () => {
  const db = mk();
  await assert.rejects(P.seedPrediction(db, { id: 'a', subject: '', op: '>=', value: 1, hours: 1 }, { now: NOW }), /metric or issue/);
  await assert.rejects(P.seedPrediction(db, { id: 'b', subject: 'm', op: '~', value: 1, hours: 1 }, { now: NOW }), /operator/);
  await assert.rejects(P.seedPrediction(db, { id: 'c', subject: 'm', op: '>=', hours: 1 }, { now: NOW }), /numeric target/);
  await assert.rejects(P.seedPrediction(db, { id: 'd', subject: 'm', op: '>=', value: 1 }, { now: NOW }), /due time/);
  await assert.rejects(P.seedPrediction(db, { id: 'e', subject: 'm', op: 'between', value: 5, value2: 1, hours: 1 }, { now: NOW }), /between/);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM predict_predictions`).n, 0);
  await P.seedPrediction(db, { id: 'ok', subject: 'm', op: '>=', value: 1, hours: 2 }, { now: NOW });
  assert.deepEqual({ ...one(db, `SELECT origin, due_at FROM predict_predictions WHERE id='ok'`) }, { origin: 'seeded', due_at: '2026-11-11 12:00:00' });
});

test('US-05-T01, US-05-R02 a due prediction items_done >= 1 with one done item scores hit, observed 1, and writes an outcome row; one not yet due is left alone', async () => {
  const db = mk();
  item(db, 'I1', 'done', 'done: observed');
  await P.registerMetric(db, { name: 'items_done', read_sql: `SELECT COUNT(*) FROM items WHERE status='done'` });
  await P.seedPrediction(db, { id: 'P1', subject: 'items_done', op: '>=', value: 1, due_at: '2026-11-11 10:00:00', surface: 'work_tracker', action_class: 'execute' });
  await P.seedPrediction(db, { id: 'P2', subject: 'items_done', op: '>=', value: 1, hours: 5 }, { now: NOW });
  const r = await P.scoreDue(db, { now: NOW });
  assert.deepEqual(r, [{ id: 'P1', observed: 1, matched: 1, verdict: 'hit', reason: null }]);
  assert.deepEqual({ ...one(db, `SELECT observed, matched, scored_at FROM predict_predictions WHERE id='P1'`) }, { observed: 1, matched: 1, scored_at: '2026-11-11 10:00:00' });
  assert.equal(one(db, `SELECT matched FROM predict_predictions WHERE id='P2'`).matched, null);
  assert.deepEqual({ ...one(db, `SELECT prediction_id, observed, matched FROM predict_outcomes`) }, { prediction_id: 'P1', observed: 1, matched: 1 });
  assert.equal(one(db, `SELECT result FROM outcomes WHERE surface='work_tracker' AND action_class='execute'`).result, 'verified');
  assert.deepEqual(await P.scoreDue(db, { now: NOW }), [], 'a scored prediction is not scored twice');
});

test('US-05-T02, US-05-R03 an unknown metric or operator scores as a miss with observed null; so does a metric that fails', async () => {
  const db = mk();
  await P.seedPrediction(db, { id: 'P1', subject: 'nonexistent', op: '>=', value: 1, due_at: '2026-11-11 09:00:00' });
  await P.seedPrediction(db, { id: 'P3', subject: 'broken', op: '>=', value: 1, due_at: '2026-11-11 09:00:00' });
  db.raw.prepare(`INSERT INTO predict_predictions (id, form, subject, op, value, due_at) VALUES ('P2','metric','known','!=',1,'2026-11-11 09:00:00')`).run();
  const r = await P.scoreDue(db, { now: NOW, metrics: { known: () => 1, broken: () => { throw new Error('store down'); } } });
  const by = Object.fromEntries(r.map(x => [x.id, x]));
  assert.deepEqual([by.P1.verdict, by.P1.observed, by.P1.reason], ['miss', null, 'unknown metric']);
  assert.deepEqual([by.P2.verdict, by.P2.observed, by.P2.reason], ['miss', null, 'unknown operator']);
  assert.deepEqual([by.P3.verdict, by.P3.observed], ['miss', null]);
  assert.match(by.P3.reason, /store down/);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM predict_predictions WHERE matched IS NULL`).n, 0, 'nothing stays unscored');
});

test('section 3.1 worked example: "program_focus_without_doer <= 1 within 24 h" reads 1 at the first run after the due time and matches; between and issue forms score', async () => {
  const db = mk();
  item(db, 'FIX-1', 'done', 'done: observed'); item(db, 'FIX-2', 'ready');
  await P.recordDecision(db, { id: 'A', decision: 'focus', predicted_outcome: 'program_focus_without_doer <= 1 within 24 h', revert_path: 'restore focus list' }, { now: NOW });
  await P.recordDecision(db, { id: 'B', decision: 'tune', predicted_outcome: 'latency between 80 and 120 within 24 h', revert_path: 'restore config' }, { now: NOW });
  await P.recordDecision(db, { id: 'C', decision: 'fix', predicted_outcome: 'issue FIX-1 closed within 24 h', revert_path: 'revert commit' }, { now: NOW });
  await P.recordDecision(db, { id: 'D', decision: 'fix', predicted_outcome: 'issue FIX-2 closed within 24 h', revert_path: 'revert commit' }, { now: NOW });
  const metrics = { program_focus_without_doer: () => 1, latency: () => 130 };
  assert.equal((await P.scoreDue(db, { now: NOW + 23 * H, metrics })).length, 0);
  const r = Object.fromEntries((await P.scoreDue(db, { now: NOW + 24 * H + 600e3, metrics })).map(x => [x.id, x.matched]));
  assert.deepEqual(r, { 'P-A': 1, 'P-B': 0, 'P-C': 1, 'P-D': 0 });
});

test('section 3.2 calibration views give the matched share by persona, action class and surface', async () => {
  const db = mk();
  const rows = [['pm', 'assign', 'work_tracker', 1], ['pm', 'assign', 'work_tracker', 0], ['pm', 'merge', 'repo', 1], ['ops', 'merge', 'repo', 1]];
  rows.forEach(([persona, action_class, surface, m], i) => db.raw.prepare(`INSERT INTO predict_predictions (id, form, subject, op, value, due_at, persona, action_class, surface, matched) VALUES (?, 'metric','m','>=',1,'2026-11-11 00:00:00',?,?,?,?)`).run('p' + i, persona, action_class, surface, m));
  const v = await P.calibrationViews(db);
  assert.deepEqual(v.by_persona.map(r => [r.persona, r.scored, r.matched_share]), [['ops', 1, 1], ['pm', 3, 2 / 3]]);
  assert.deepEqual(v.by_action_class.map(r => [r.action_class, r.matched_share]), [['assign', 0.5], ['merge', 1]]);
  assert.deepEqual(v.by_surface.map(r => [r.surface, r.matched_share]), [['repo', 1], ['work_tracker', 0.5]]);
});

function seedBin(db, type, p, n, hits, tag) {
  const st = db.raw.prepare(`INSERT INTO predict_predictions (id, form, subject, op, value, due_at, confidence, decision_type, matched) VALUES (?, 'metric','m','>=',1,'2026-11-11 00:00:00',?,?,?)`);
  for (let i = 0; i < n; i++) st.run(`${tag}-${i}`, p, type, i < hits ? 1 : 0);
}

test('US-05-R13 binned calibration: 40 predictions at 0.85 matched 28 times give h = 0.70 and the confidence cap falls by 0.15', async () => {
  const db = mk();
  seedBin(db, 'merge', 0.85, 40, 28, 'a');
  seedBin(db, 'merge', 0.55, 10, 6, 'b');
  seedBin(db, 'deploy', 0.95, 30, 30, 'c');
  const types = await P.calibrate(db, { now: NOW });
  const merge = types.find(t => t.decision_type === 'merge');
  assert.deepEqual(merge.bins.map(b => [b.range, b.n]), [['0.5-0.6', 10], ['0.8-0.9', 40]]);
  const b = merge.bins[1];
  assert.ok(Math.abs(b.hit_rate - 0.70) < 1e-9 && Math.abs(b.mean_p - 0.85) < 1e-9);
  // calibration error: count-weighted mean of |p_bin - h_bin| = (10*0.05 + 40*0.15) / 50
  assert.ok(Math.abs(merge.calibration_error - 0.13) < 1e-9);
  // Brier: mean of (p - outcome)^2
  const brier = (28 * 0.15 ** 2 + 12 * 0.85 ** 2 + 6 * 0.45 ** 2 + 4 * 0.55 ** 2) / 50;
  assert.ok(Math.abs(merge.brier - brier) < 1e-9);
  const g = await P.gateConfidence(db, { decision_type: 'merge', confidence: 0.85, threshold: 0.8 });
  assert.ok(Math.abs(g.correction - 0.15) < 1e-9 && Math.abs(g.corrected - 0.70) < 1e-9);
  assert.equal(g.allowed, false, 'stated 0.85 no longer clears a 0.8 gate');
  // per decision type: a well calibrated type is not corrected; a thin bin (n < 20) corrects nothing; under-confidence is not rewarded
  assert.equal((await P.gateConfidence(db, { decision_type: 'deploy', confidence: 0.95, threshold: 0.9 })).allowed, true);
  assert.equal((await P.gateConfidence(db, { decision_type: 'merge', confidence: 0.55, threshold: 0.5 })).correction, 0);
  assert.equal((await P.gateConfidence(db, { decision_type: 'merge', confidence: 0.4, threshold: 0.3 })).allowed, false);
  assert.equal((await P.binnedCalibration(db, { decision_type: 'deploy' }))[0].bins[0].range, '0.9-1.0');
});

test('US-05-R08 the three health numbers are computed over 7 days and each breach files one item; an unmeasured number files nothing', async () => {
  const db = mk();
  assert.deepEqual((await P.checkHealth(db, { now: NOW })).filed, []);
  await P.recordDecision(db, { id: 'D1', decision: 'a', predicted_outcome: 'm >= 1 within 1 h', revert_path: 'u' }, { now: NOW - 30 * H });
  await P.recordDecision(db, { id: 'D2', decision: 'b', predicted_outcome: 'things improve', revert_path: 'u' }, { now: NOW - 20 * H });
  await P.recordDecision(db, { id: 'D3', decision: 'c', predicted_outcome: 'm >= 9 within 1 h', revert_path: 'u' }, { now: NOW - 10 * H });
  await P.recordDecision(db, { id: 'OLD', decision: 'c', predicted_outcome: 'nothing parsable', revert_path: 'u' }, { now: NOW - 9 * 86400e3 });
  await P.scoreDue(db, { now: NOW - 5 * H, metrics: { m: () => 1 }, limit: 1 });
  let h = await P.health(db, { now: NOW });
  assert.ok(Math.abs(h.parsable_share_7d - 2 / 3) < 1e-9);
  assert.equal(h.miss_rate_7d, 0); assert.equal(h.unscored_overdue, 1);
  const c = await P.checkHealth(db, { now: NOW });
  assert.deepEqual(c.filed, ['PREDICT-parsable-share-2026-11-11', 'PREDICT-unscored-overdue-2026-11-11']);
  assert.deepEqual((await P.checkHealth(db, { now: NOW })).filed, [], 'one item per number and day');
  await P.scoreDue(db, { now: NOW, metrics: { m: () => 1 } });
  h = await P.health(db, { now: NOW });
  assert.equal(h.miss_rate_7d, 0.5); assert.equal(h.unscored_overdue, 0);
  assert.deepEqual((await P.checkHealth(db, { now: NOW, config: { max_miss_rate_7d: 0.4, min_parsable_share_7d: 0.5 } })).filed, ['PREDICT-miss-rate-2026-11-11']);
});

const ASSERT = { deciding_query: `SELECT COUNT(*) FROM tick_runs WHERE report = 'v1.2.8 live'`, pass_condition: '> 0', fail_condition: '= 0', null_expectation: 'no row reports v1.2.8' };

test('US-05-R10, US-05-R04, US-05-R05 code-only and staged evidence leave the finding pending; observed cannot be asserted, only read', async () => {
  const db = mk();
  item(db, 'F1');
  assert.deepEqual(await P.closeFinding(db, 'F1', { now: NOW }), { finding_id: 'F1', closed: false, status: 'pending', state: 'none' });
  for (const state of ['code-only', 'staged']) {
    await P.recordAssertion(db, { finding_id: 'F1', state, ...ASSERT, evidence: 'merged in commit abc', produced_by: 'doer-1' }, { now: NOW });
    const r = await P.closeFinding(db, 'F1', { now: NOW });
    assert.deepEqual([r.closed, r.status, r.state], [false, 'pending', state]);
    assert.equal(one(db, `SELECT status FROM items WHERE id='F1'`).status, 'ready');
  }
  assert.match(one(db, `SELECT blocker FROM items WHERE id='F1'`).blocker, /^pending: assertion state staged/);
  await assert.rejects(P.recordAssertion(db, { finding_id: 'F1', state: 'observed', ...ASSERT }), /only by observe/);
  await assert.rejects(P.recordAssertion(db, { finding_id: 'F1', state: 'staged', ...ASSERT, null_expectation: '' }), /null_expectation/);
  // the done check was never observed: the deciding query reads 0, so the item stays open
  const o = await P.observe(db, 'F1', { now: NOW, verified_by: 'probe' });
  assert.equal(o.observed, false); assert.match(o.reason, /does not meet > 0/);
  assert.equal((await P.closeFinding(db, 'F1', { now: NOW })).closed, false);
  // the territory changes; the deciding query now observes it
  db.raw.prepare(`INSERT INTO tick_runs (started_at, steps_total, report) VALUES ('2026-11-11 09:00:00', 1, 'v1.2.8 live')`).run();
  const o2 = await P.observe(db, 'F1', { now: NOW, verified_by: 'probe' });
  assert.deepEqual([o2.observed, o2.state, o2.value, o2.independent], [true, 'observed', 1, 1]);
  const c = await P.closeFinding(db, 'F1', { now: NOW });
  assert.deepEqual([c.closed, c.state, c.label], [true, 'observed', null]);
  assert.match(one(db, `SELECT disposition FROM items WHERE id='F1'`).disposition, /^done: observed/);
});

test('US-05-R12 the verifying path is recorded as independent or not, and can be required', async () => {
  const db = mk();
  item(db, 'F2');
  db.raw.prepare(`INSERT INTO tick_runs (started_at, steps_total, report) VALUES ('2026-11-11 09:00:00', 1, 'v1.2.8 live')`).run();
  await P.recordAssertion(db, { finding_id: 'F2', state: 'staged', ...ASSERT, produced_by: 'doer-1' }, { now: NOW });
  const same = await P.observe(db, 'F2', { now: NOW, verified_by: 'doer-1', require_independent: true });
  assert.equal(same.observed, false); assert.match(same.reason, /not independent/);
  const read = async (q) => { assert.equal(q, ASSERT.deciding_query); return 3; };
  const other = await P.observe(db, 'F2', { now: NOW, verified_by: 'outside-probe', require_independent: true, read });
  assert.deepEqual([other.observed, other.value, other.independent], [true, 3, 1]);
});

test('US-05-R11 a closure at inferred carries the label and a re-test date; the re-test upgrades it to observed or reopens the finding', async () => {
  const db = mk();
  item(db, 'F3'); item(db, 'F4');
  await assert.rejects(P.recordAssertion(db, { finding_id: 'F3', state: 'inferred', ...ASSERT }), /re-test date/);
  for (const f of ['F3', 'F4']) await P.recordAssertion(db, { finding_id: f, state: 'inferred', ...ASSERT, evidence: 'no hourly failure since the tombstone', retest_at: '2026-11-12 10:00:00' }, { now: NOW });
  const c = await P.closeFinding(db, 'F3', { now: NOW }); await P.closeFinding(db, 'F4', { now: NOW });
  assert.deepEqual([c.closed, c.label, c.retest_at], [true, 'inferred', '2026-11-12 10:00:00']);
  assert.match(one(db, `SELECT disposition FROM items WHERE id='F3'`).disposition, /inferred.*re-test 2026-11-12 10:00:00/);
  assert.deepEqual(await P.retestDue(db, { now: NOW }), [], 'not due yet');
  const read = async () => 0;
  const r = await P.retestDue(db, { now: NOW + 25 * H, read: undefined });
  assert.deepEqual(r.map(x => [x.finding_id, x.result]), [['F3', 'reopened'], ['F4', 'reopened']]);
  assert.equal(one(db, `SELECT status FROM items WHERE id='F3'`).status, 'ready');
  assert.equal((await P.closeFinding(db, 'F3', { now: NOW + 26 * H })).closed, false, 'a reopened finding does not close again on the old inference');
  assert.deepEqual(await P.retestDue(db, { now: NOW + 30 * H, read }), [], 're-tested once');
  // a passing re-test
  item(db, 'F5');
  await P.recordAssertion(db, { finding_id: 'F5', state: 'inferred', ...ASSERT, retest_at: '2026-11-12 10:00:00' }, { now: NOW });
  await P.closeFinding(db, 'F5', { now: NOW });
  const ok = await P.retestDue(db, { now: NOW + 25 * H, read: async () => 2 });
  assert.deepEqual(ok, [{ finding_id: 'F5', result: 'observed', value: 2 }]);
  assert.match(one(db, `SELECT disposition FROM items WHERE id='F5'`).disposition, /observed on re-test/);
});

test('step runs the scorer, the re-test, calibration and the health triggers in one pass', async () => {
  const db = mk();
  await P.recordDecision(db, { id: 'D1', decision: 'a', predicted_outcome: 'm >= 1 within 1 h', revert_path: 'u', confidence: 0.9, decision_type: 'merge' }, { now: NOW - 2 * H });
  const r = await P.step({ db, now: NOW, metrics: { m: () => 4 } });
  assert.deepEqual([r.scored, r.hits, r.retested, r.health.unscored_overdue], [1, 1, 0, 0]);
  assert.equal(one(db, `SELECT n FROM predict_confidence_caps WHERE decision_type='merge'`).n, 1);
});
