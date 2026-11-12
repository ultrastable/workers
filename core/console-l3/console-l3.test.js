// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// US-SPEC-13 conformance (US-13-T01..T05 for the L3 parts) and the console wiring (issue #46).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createConsoleL3 } from './index.js';
import { handleConsole } from '../src/console.js';

const MIG = fileURLToPath(new URL('./migrations/', import.meta.url));
const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
const LIMITS = 'The system grades itself (self-measurement bias); rubrics are applied by analogy; evidence is point-in-time.';
const mk = () => { const db = makeDb([MIG]); const t = { v: T0 }; return { db, t, l3: createConsoleL3({ db, now: () => t.v, config: { version: '1.2.3' } }) }; };
const seed = db => db.raw.exec(`
  INSERT INTO items (id,title,owner_role,done_check,status) VALUES ('A','a','staff','x','ready'),('B','b','staff','x','done'),('C','c','staff','x','claimed');
  INSERT INTO items (id,title,owner_role,done_check,status,blocker) VALUES ('D','d','staff','x','blocked','w');
  INSERT INTO gate_cards (id,what,why_gated,default_in_effect,closing_probe) VALUES ('G1','Approve spend','money','stays zero','manual');
  INSERT INTO tick_runs (started_at,finished_at,steps_completed,steps_total) VALUES ('2026-11-12T11:00:00Z','2026-11-12T11:00:01Z',5,5);
  INSERT INTO predictions (id,item_id,metric,op,target,due_at,verdict) VALUES ('P1','A','m','>=',1,'2026-11-12','hit'),('P2','A','m','>=',1,'2026-11-12','miss');`);
const good = (dim, score, extra = {}) => ({ dimension: dim, score, evidence: `table:${dim}`, confidence: 'medium', status: 'measured', ...extra });

test('US-13-T01: /health and /api/state return JSON with version and counts; unknown paths and methods return null', async () => {
  const { db, l3 } = mk(); seed(db);
  const h = await (await l3.handle(new Request('https://x.example/health'))).json();
  assert.deepEqual(h.counts, { items: 4, open_gate_cards: 1, blocked: 1 }); assert.equal(h.version, '1.2.3'); assert.equal(h.ok, true);
  const s = await (await l3.handle(new Request('https://x.example/api/state'))).json();
  assert.deepEqual(s.items, { open: 1, claimed: 1, blocked: 1, done: 1, total: 4 });
  assert.deepEqual(s.predictions, { hit: 1, scored: 2 }); assert.equal(s.waiting_on_a_person, 2);
  assert.equal(await l3.handle(new Request('https://x.example/nope')), null);
  assert.equal(await l3.handle(new Request('https://x.example/health', { method: 'POST' })), null);
});

test('US-13-R02: the digest is computed from the same state the dashboard serves', async () => {
  const { db, l3 } = mk(); seed(db);
  const d = await l3.digest(); const s = await l3.state();
  assert.deepEqual(d.state, s);
  assert.match(d.text, /1 open, 1 in progress, 1 blocked, 1 done/); assert.match(d.text, /waiting on a person: 2/); assert.match(d.text, /1 of 2 called right/);
});

test('health is not ok before the first check and when a check did not finish', async () => {
  const { db, l3 } = mk();
  assert.equal((await l3.health()).ok, false);
  db.raw.exec(`INSERT INTO tick_runs (started_at,steps_completed,steps_total) VALUES ('2026-11-12T11:00:00Z',2,5)`);
  assert.equal((await l3.health()).ok, false);
});

test('US-13-T02 and R03: a score without evidence, confidence or status is rejected and nothing is stored', async () => {
  const { db, l3 } = mk();
  const r = await l3.recordCard({ name: 'autonomy', rubric: 'r1', limits: LIMITS, scores: [good('loops', 4), { dimension: 'cost', score: 3 }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /evidence pointer is required/.test(e)) && r.errors.some(e => /confidence/.test(e)) && r.errors.some(e => /status/.test(e)));
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM l3_scores').get().n, 0);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM l3_cards').get().n, 0);
});

test('US-13-R04: a card must state self-measurement bias in its limits', async () => {
  const { l3 } = mk();
  const r = await l3.recordCard({ name: 'autonomy', rubric: 'r1', limits: 'point-in-time evidence only', scores: [good('loops', 4)] });
  assert.equal(r.ok, false); assert.match(r.errors[0], /self-measurement bias/);
  assert.equal((await l3.recordCard({ name: 'autonomy', rubric: 'r1', limits: LIMITS, scores: [good('loops', 4)] })).ok, true);
});

test('US-13-T05 and R05: a fall of 0.6 with no cause files a work item; with a cause, or a fall of 0.4, it does not', async () => {
  const { db, l3 } = mk();
  await l3.recordCard({ name: 'autonomy', rubric: 'r1', limits: LIMITS, scores: [good('loops', 4), good('cost', 3), good('speed', 3)] });
  const r = await l3.recordCard({ name: 'autonomy', rubric: 'r1', limits: LIMITS, scores: [good('loops', 3.4), good('cost', 1, { cause: 'budget cap hit after the model change' }), good('speed', 2.6)] });
  assert.deepEqual(r.items, ['L3-DROP-AUTONOMY-LOOPS']);
  const it = db.raw.prepare("SELECT status, project FROM items WHERE id='L3-DROP-AUTONOMY-LOOPS'").get();
  assert.deepEqual({ ...it }, { status: 'open', project: 'report-card' });
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM items WHERE id LIKE 'L3-DROP%'").get().n, 1);
});

test('reportCard returns the latest scores, evidence, limits and the mean', async () => {
  const { l3 } = mk();
  await l3.recordCard({ name: 'autonomy', rubric: 'r1', limits: LIMITS, scores: [good('a', 2), good('b', 4)] });
  await l3.recordCard({ name: 'autonomy', rubric: 'r1', limits: LIMITS, scores: [good('a', 3), good('b', 4)] });
  const c = await l3.reportCard('autonomy');
  assert.equal(c.overall, 3.5); assert.equal(c.scores.length, 2); assert.equal(c.scores[0].evidence, 'table:a'); assert.match(c.limits, /self-measurement/);
  assert.equal(await l3.reportCard('none'), null);
  const res = await l3.handle(new Request('https://x.example/api/report-card?name=missing'));
  assert.equal(res.status, 404);
});

test('US-13-R06: a change to the objective function can be proposed and is never adopted', async () => {
  const { db, l3 } = mk();
  const p = await l3.proposeObjectiveChange('weight cost overrun higher');
  assert.equal(p.status, 'proposed');
  assert.equal((await l3.proposeObjectiveChange('  ')).ok, false);
  const a = await l3.adoptObjectiveChange(p.id);
  assert.equal(a.ok, false); assert.equal(a.refusal, 'objective_function_is_not_self_adoptable');
  assert.equal(db.raw.prepare('SELECT status FROM l3_proposals').get().status, 'proposed');
});

test('US-13-T04 and R11: a step at 5 h of a 4 h budget files an item; at 9 h exactly one question, never a second', async () => {
  const { db, t, l3 } = mk();
  const run = { process: 'review', step: 'check', started_at: T0 - 5 * 3600e3, budget_hours: 4 };
  assert.deepEqual(await l3.sweepStepBudgets([run]), [{ key: 'REVIEW-CHECK', kind: 'item' }]);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM gate_cards WHERE id LIKE 'stepq-%'").get().n, 0);
  t.v = T0 + 4 * 3600e3; // now 9 h elapsed
  const filed = await l3.sweepStepBudgets([run]);
  assert.deepEqual(filed.map(f => f.kind), ['item', 'question']);
  await l3.sweepStepBudgets([run]); // a later sweep adds no second question
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM gate_cards WHERE id LIKE 'stepq-%'").get().n, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM items WHERE id LIKE 'STEPBUDGET-%'").get().n, 1);
  assert.deepEqual(await l3.sweepStepBudgets([{ ...run, done: true }, { ...run, step: 'quick', started_at: t.v - 3600e3 }]), []);
});

test('console wiring: /api/console/fleet/* needs sign-in and serves the L3 routes', async () => {
  const { db, l3 } = mk(); seed(db);
  const env = { DB: db, CONSOLE_TOKEN: 'console-token-1234' };
  const o = { l3, now: () => T0 };
  const cookie = 'us_console=' + encodeURIComponent(env.CONSOLE_TOKEN);
  assert.equal((await handleConsole(new Request('https://x.example/api/console/fleet/state'), env, o)).status, 401);
  const ok = await handleConsole(new Request('https://x.example/api/console/fleet/state', { headers: { cookie } }), env, o);
  assert.equal(ok.status, 200); assert.equal((await ok.json()).version, '1.2.3');
  assert.equal((await handleConsole(new Request('https://x.example/api/console/fleet/zzz', { headers: { cookie } }), env, o)).status, 404);
  assert.equal((await (await handleConsole(new Request('https://x.example/api/console/fleet/digest', { headers: { cookie } }), env, o)).json()).state.items.total, 4);
});
