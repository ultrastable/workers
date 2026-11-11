// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { kdb, setv, probe, item, one, rows, HOUR } from './testkit.js';
import { registerMetric } from './metrics.js';
import {
  registerFailureMode, runDetectors, detectStaleDetectors, confirmFiring, reviewProbation, payloadIsFailure, consumeRemediations,
  recordLoopRun, canAttempt, recordAttempt, proposeRemedy, judgeRemedies,
} from './failure.js';

const contract = (o = {}) => ({ owner: 'ops', doer: 'fixer', alt_doers: ['fixer', 'fixer2'], closing_probe: probe('queue_err'), pass: '= 0', max_attempts: 2, backoff_h: [1, 4], deadline_h: 72, ...o });
const fm = (o = {}) => ({ id: 'FM-Q', name: 'queue coverage', severity: 4, detector_sql: `SELECT v AS value, 10.0 AS expected FROM t_vals WHERE k = 'seen'`, fire_when: 'value < 0.8*expected', contract: contract(), ...o });
const now = () => Date.now();

test('US-17-T01: a detector that does not fire still writes a hit row (fired = 0)', async () => {
  const db = kdb(); setv(db, 'seen', 10);
  await registerFailureMode(db, fm());
  assert.deepEqual(await runDetectors(db, { now: now() }), []);
  const h = one(db, `SELECT * FROM kernel_failure_mode_hits`);
  assert.equal(h.fired, 0); assert.equal(h.value, 10); assert.equal(h.expected, 10);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM items`).n, 0);
});

test('a firing detector opens an item carrying a full remediation contract, once (US-17-R04)', async () => {
  const db = kdb(); setv(db, 'seen', 2);
  await registerFailureMode(db, fm());
  const f = await runDetectors(db, { now: now() });
  assert.equal(f.length, 1);
  const it = one(db, `SELECT * FROM items WHERE id = ?`, f[0].item);
  assert.equal(it.priority, 1); assert.equal(it.owner_role, 'ops'); assert.match(it.done_check, /closing probe passes/);
  const r = one(db, `SELECT * FROM kernel_remediations WHERE item_id = ?`, f[0].item);
  assert.equal(r.doer, 'fixer'); assert.equal(r.max_attempts, 2); assert.equal(r.deadline_h, 72); assert.ok(r.closing_probe);
  await runDetectors(db, { now: now() });
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM kernel_remediations`).n, 1, 'no second remediation while one is open');
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM kernel_failure_mode_hits WHERE fired = 1`).n, 2);
});

test('a failure mode without a detector, severity or contract field cannot be registered (US-17-R03/R04)', async () => {
  const db = kdb();
  await assert.rejects(registerFailureMode(db, fm({ detector_sql: 'DELETE FROM items' })), /SELECT/);
  await assert.rejects(registerFailureMode(db, fm({ severity: 9 })), /severity/);
  await assert.rejects(registerFailureMode(db, fm({ fire_when: 'process.exit()' })), /fire_when/);
  for (const f of ['owner', 'doer', 'closing_probe', 'max_attempts', 'deadline_h']) {
    await assert.rejects(registerFailureMode(db, fm({ contract: contract({ [f]: undefined }) })), new RegExp(f));
  }
});

test('a detector that errors writes a hit row with the error, not silence', async () => {
  const db = kdb();
  await registerFailureMode(db, fm({ detector_sql: 'SELECT * FROM no_such_table' }));
  await runDetectors(db, { now: now() });
  const h = one(db, `SELECT * FROM kernel_failure_mode_hits`);
  assert.equal(h.value, null); assert.match(h.evidence, /detector error/);
});

test('US-17-T02: a detector that stopped writing is itself detected (frozen)', async () => {
  const db = kdb(); setv(db, 'seen', 10);
  await registerFailureMode(db, fm(), now() - 10 * HOUR);
  const filed = await detectStaleDetectors(db, { now: now() });
  assert.equal(filed.length, 1); assert.match(filed[0], /^FM-STALE-FM-Q-/);
  await runDetectors(db, { now: now() });
  const again = await detectStaleDetectors(db, { now: now() + 1 * HOUR });
  assert.deepEqual(again, [], 'a recent hit row clears it');
});

test('US-17-R09: a detector mostly refuted by verification goes to probation and stops opening items', async () => {
  const db = kdb(); setv(db, 'seen', 2);
  await registerFailureMode(db, fm());
  for (let i = 0; i < 10; i++) db.raw.prepare(`INSERT INTO kernel_failure_mode_hits (fm_id, ts, value, expected, fired, confirmed) VALUES ('FM-Q','2026-01-01 00:00:00',2,10,1,?)`).run(i < 4 ? 1 : 0);
  assert.deepEqual(await reviewProbation(db), ['FM-Q']);
  assert.equal(one(db, `SELECT status FROM kernel_failure_modes`).status, 'probation');
  await runDetectors(db, { now: now() });
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM kernel_remediations`).n, 0);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM kernel_failure_mode_hits WHERE id > 10`).n, 1, 'it still writes hit rows');
  await confirmFiring(db, 1, false); assert.equal(one(db, `SELECT confirmed FROM kernel_failure_mode_hits WHERE id=1`).confirmed, 0);
});

test('US-17-T06: a count named failed is not a failure; structured errors are', () => {
  assert.equal(payloadIsFailure('{"queued":0,"failed":2,"published":19}'), false);
  assert.equal(payloadIsFailure({ ok: false }), true);
  assert.equal(payloadIsFailure('{"ok":true,"error":"timeout"}'), true);
  assert.equal(payloadIsFailure('not json'), false);
});

async function armed(o = {}) {
  const db = kdb(); setv(db, 'seen', 2); setv(db, 'queue_err', 3);
  await registerFailureMode(db, fm(o));
  const [{ item: id }] = await runDetectors(db, { now: now() });
  return { db, id };
}

test('the consumer books exactly one bucket per scanned item and closes only when the closing probe passes (US-17-R05/R06)', async () => {
  const { db, id } = await armed();
  const t0 = now();
  let r = await consumeRemediations(db, { now: t0 });
  assert.deepEqual([r.scanned, r.failed, r.executed], [1, 1, 0]);
  assert.equal(one(db, `SELECT status FROM items WHERE id = ?`, id).status, 'ready', 'a failing probe leaves the item open');
  r = await consumeRemediations(db, { now: t0 });
  assert.deepEqual([r.scanned, r.no_action], [1, 1], 'backoff: not due yet');
  setv(db, 'queue_err', 0);
  r = await consumeRemediations(db, { now: t0 + 2 * HOUR });
  assert.deepEqual([r.scanned, r.executed], [1, 1]);
  const it = one(db, `SELECT * FROM items WHERE id = ?`, id);
  assert.equal(it.status, 'done'); assert.match(it.disposition, /closed by probe/);
  assert.ok(rows(db, `SELECT balanced FROM kernel_loop_runs`).every(x => x.balanced === 1));
});

test('after max_attempts a non-eligible item is reassigned, then blocked when doers run out (US-17-R07)', async () => {
  const { db, id } = await armed();
  const t = now();
  await consumeRemediations(db, { now: t });
  let r = await consumeRemediations(db, { now: t + 2 * HOUR });
  assert.equal(r.needs_human, 1);
  assert.equal(one(db, `SELECT doer FROM kernel_remediations WHERE item_id=?`, id).doer, 'fixer2');
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM gate_cards`).n, 0, 'not interrupt-eligible: no gate card');
  await consumeRemediations(db, { now: t + 3 * HOUR });
  await consumeRemediations(db, { now: t + 9 * HOUR });
  assert.equal(one(db, `SELECT status FROM kernel_remediations WHERE item_id=?`, id).status, 'exhausted');
  assert.equal(one(db, `SELECT status FROM items WHERE id=?`, id).status, 'blocked');
});

test('an interrupt-eligible item goes through the gate card after max_attempts (US-17-R07)', async () => {
  const { db, id } = await armed({ contract: contract({ max_attempts: 1, interrupt_eligible: true }) });
  await consumeRemediations(db, { now: now() });
  const g = one(db, `SELECT * FROM gate_cards`);
  assert.equal(g.id, `GATE-${id}`); assert.equal(g.closing_probe, `item_done:${id}`); assert.equal(g.status, 'open');
  assert.equal(one(db, `SELECT status FROM kernel_remediations WHERE item_id=?`, id).status, 'needs_human');
});

test('US-17-T04: a loop that scanned 25 and booked 0 raises an incident and reopens the 25 items', async () => {
  const db = kdb(); const ids = [];
  for (let i = 0; i < 25; i++) { ids.push(`X${i}`); item(db, `X${i}`, { status: 'done', disposition: 'x' }); }
  const r = await recordLoopRun(db, { loop: 'drain', scanned: 25, unaccounted_item_ids: ids, now: now() });
  assert.equal(r.balanced, false); assert.equal(r.reopened, 25);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM items WHERE status='open' AND id LIKE 'X%'`).n, 25);
  assert.match(one(db, `SELECT id FROM items WHERE id LIKE 'UNACCOUNTED-%'`).id, /UNACCOUNTED-drain/);
  assert.equal((await recordLoopRun(db, { loop: 'drain', scanned: 5, executed: 3, failed: 1, no_action: 1 })).balanced, true);
});

test('US-17-T03: three identical failures suspend retry, file a root-cause item and schedule a half-open probe', async () => {
  const db = kdb(); const t = now();
  assert.equal((await canAttempt(db, 'deploy:a', 'E123', t)).allowed, true);
  await recordAttempt(db, { target: 'deploy:a', signature: 'E123', ok: false, now: t });
  await recordAttempt(db, { target: 'deploy:a', signature: 'E123', ok: false, now: t + HOUR });
  assert.equal((await canAttempt(db, 'deploy:a', 'E123', t + 2 * HOUR)).allowed, true, 'two failures: still allowed');
  const r = await recordAttempt(db, { target: 'deploy:a', signature: 'E123', ok: false, now: t + 2 * HOUR });
  assert.equal(r.state, 'open');
  assert.equal((await canAttempt(db, 'deploy:a', 'E123', t + 3 * HOUR)).allowed, false, 'retry suspended');
  assert.ok(one(db, `SELECT id FROM items WHERE id = ?`, r.root_item_id));
  assert.ok(one(db, `SELECT half_open_at FROM kernel_breakers`).half_open_at);
  assert.equal((await canAttempt(db, 'deploy:a', 'E123', t + 27 * HOUR)).half_open, true);
  const ext = await recordAttempt(db, { target: 'deploy:a', signature: 'E123', ok: false, now: t + 27 * HOUR });
  assert.equal(ext.extended, true); assert.equal(one(db, `SELECT interval_h FROM kernel_breakers`).interval_h, 48);
  await recordAttempt(db, { target: 'deploy:a', signature: 'E123', ok: true, now: t + 80 * HOUR });
  assert.equal((await canAttempt(db, 'deploy:a', 'E123', t + 81 * HOUR)).allowed, true);
  assert.equal(one(db, `SELECT state FROM kernel_breakers`).state, 'closed');
  assert.equal((await canAttempt(db, 'deploy:b', 'E123', t)).allowed, true, 'other targets are unaffected');
});

async function remedyDb() {
  const db = kdb();
  await registerMetric(db, { id: 'lat', op: '<=', target: 5, read_probe: probe('lat') });
  setv(db, 'lat', 20);
  return db;
}

test('a remedy that did not move its metric in the window is replaced, not repeated (conformance)', async () => {
  const db = await remedyDb(); const t = now();
  await proposeRemedy(db, { id: 'R1', metric_id: 'lat', description: 'Add a cache', window_h: 24, now: t - 48 * HOUR });
  await assert.rejects(proposeRemedy(db, { id: 'R1b', metric_id: 'lat', description: 'second at once' }), /one remedy at a time/);
  const out = await judgeRemedies(db, { now: t });
  assert.equal(out[0].status, 'replaced');
  assert.match(one(db, `SELECT title FROM items WHERE id = 'REMEDY-REPLACE-R1'`).title, /different approach/);
  await assert.rejects(proposeRemedy(db, { id: 'R2', metric_id: 'lat', description: '  add   a CACHE ' }), /repeats/);
  await proposeRemedy(db, { id: 'R3', metric_id: 'lat', description: 'Batch the writes', window_h: 1, now: t });
  setv(db, 'lat', 8);
  assert.equal((await judgeRemedies(db, { now: t + 2 * HOUR }))[0].status, 'effective');
  assert.equal(one(db, `SELECT status FROM kernel_remedies WHERE id='R3'`).status, 'effective');
});

test('a remedy window that has not ended is not judged; an unmeasured metric is not a success', async () => {
  const db = await remedyDb(); const t = now();
  await proposeRemedy(db, { id: 'R1', metric_id: 'lat', description: 'x', window_h: 24, now: t });
  assert.deepEqual(await judgeRemedies(db, { now: t + HOUR }), []);
  db.raw.exec(`DELETE FROM t_vals`);
  const out = await judgeRemedies(db, { now: t + 25 * HOUR });
  assert.equal(out[0].status, 'replaced');
  assert.equal(one(db, `SELECT outcome FROM kernel_remedies`).outcome, 'unmeasured');
});
