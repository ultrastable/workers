// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import * as L from './index.js';

const MIG = fileURLToPath(L.MIGRATIONS_DIR);
const NOW = Date.UTC(2026, 10, 11, 10, 0, 0);
const mk = () => makeDb([MIG]);
const one = (db, sql, ...a) => db.raw.prepare(sql).get(...a);
const rows = (db, sql, ...a) => db.raw.prepare(sql).all(...a);
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
const good = async () => ({ tool_calls: true, schema: true });
const cand = (over = {}) => ({ model: 'm-cheap', task_class: 'triage', rung: 1, unit_cost: 0.002, ctx_tokens: 128000, max_out: 32768, need: { tool_calls: true }, canary: good, ...over });
const sample = (n, agree) => Array.from({ length: n }, (_, i) => ({ label: 'A', answer: i < agree ? 'A' : 'B' }));

test('migration is idempotent; tables and views are ladder_ prefixed; the matrix has the columns of the specification', () => {
  const db = mk();
  const sql = readFileSync(MIG + '0001_ladder.sql', 'utf8');
  db.raw.exec(sql); db.raw.exec(sql);
  for (const m of sql.matchAll(/CREATE (?:TABLE IF NOT EXISTS|VIEW) (\w+)/g)) assert.match(m[1], /^ladder_/);
  assert.deepEqual(rows(db, `PRAGMA table_info(ladder_model_task_matrix)`).map(c => c.name),
    ['task_class', 'rung', 'model', 'unit_cost', 'canary_tool_calls', 'canary_schema', 'ctx_tokens', 'max_out', 'agreement', 'admitted_at', 'probed_at']);
  assert.deepEqual(rows(db, `PRAGMA table_info(ladder_model_admission)`).map(c => c.name),
    ['id', 'model', 'task_class', 'stage', 'n', 'agree', 'lower_bound', 'gate', 'decided_at', 'reason', 'evidence']);
});

test('persisted capability matrix: admission is the path that writes a rung row, with every stage recorded', async () => {
  const db = mk();
  const r = await L.admit(db, cand(), { now: NOW });
  assert.deepEqual(r, { admitted: true, stage: 'admitted', agree: null });
  assert.deepEqual({ ...one(db, `SELECT * FROM ladder_model_task_matrix`) }, { task_class: 'triage', rung: 1, model: 'm-cheap', unit_cost: 0.002, canary_tool_calls: 1, canary_schema: 1,
    ctx_tokens: 128000, max_out: 32768, agreement: null, admitted_at: '2026-11-11 10:00:00', probed_at: '2026-11-11 10:00:00' });
  assert.deepEqual(rows(db, `SELECT stage FROM ladder_model_admission ORDER BY id`).map(x => x.stage), ['floor', 'canary', 'admitted']);
  await assert.rejects(L.admit(db, cand({ rung: undefined })), /integer rung/);
  await assert.rejects(L.admit(db, cand({ gate: 0.3, decision: true })), /class gate must be between 0.6 and 0.85/);
});

test('US-09-R11 floor: a model of a banned class is rejected at the floor with the reason and never reaches the canary', async () => {
  const db = mk();
  await L.setFloor(db, [{ pattern: '-(mini|nano|fast)\\b', reason: 'small or quantized fast variant' }, { pattern: '^legacy-', reason: 'legacy class' }]);
  let ran = 0;
  const r = await L.admit(db, cand({ model: 'vendor-large-fast', canary: async () => { ran++; return {}; } }), { now: NOW });
  assert.deepEqual([r.admitted, r.stage, ran], [false, 'floor', 0]);
  assert.match(one(db, `SELECT reason FROM ladder_model_admission WHERE stage='rejected'`).reason, /^floor: small or quantized fast variant/);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM ladder_model_task_matrix`).n, 0);
  assert.equal(await L.floorViolation(db, 'vendor-large'), null);
});

test('US-09-T04, US-09-R08 capability first: a model with canary_tool_calls = 0 is refused for a class that needs tool calls, whatever its price', async () => {
  const db = mk();
  const noTools = await L.admit(db, cand({ model: 'm-cheapest', unit_cost: 0.0001, canary: async () => ({ tool_calls: false, schema: true }) }), { now: NOW });
  assert.deepEqual([noTools.admitted, noTools.stage, noTools.reason], [false, 'canary', 'no valid tool calls']);
  // admitted for a class that needs only schema output, its row carries canary_tool_calls = 0
  await L.admit(db, cand({ model: 'm-cheapest', unit_cost: 0.0001, need: { schema: true }, canary: async () => ({ tool_calls: false, schema: true }) }), { now: NOW });
  await L.admit(db, cand({ model: 'm-tools', unit_cost: 0.004 }), { now: NOW });
  assert.equal(one(db, `SELECT canary_tool_calls FROM ladder_model_task_matrix WHERE model='m-cheapest'`).canary_tool_calls, 0);
  assert.deepEqual(await L.canRoute(db, { task_class: 'triage', model: 'm-cheapest', need: { tool_calls: true } }), { ok: false, refusal: 'canary_tool_calls' });
  assert.equal((await L.canRoute(db, { task_class: 'triage', model: 'm-cheapest', need: { schema: true } })).ok, true);
  assert.deepEqual(await L.canRoute(db, { task_class: 'triage', model: 'm-unknown' }), { ok: false, refusal: 'not_admitted' });
  assert.deepEqual((await L.candidates(db, { task_class: 'triage', need: { tool_calls: true } })).map(r => r.model), ['m-tools'], 'the cheaper model without tool calls is not a candidate');
  assert.deepEqual((await L.candidates(db, { task_class: 'triage' })).map(r => r.model), ['m-cheapest', 'm-tools'], 'price breaks ties inside a rung');
});

test('US-09-T06, US-09-R12 a decision model with agreement 0.17 against a gate of 0.7 is rejected for that class and the agreement is stored', async () => {
  const db = mk();
  const r = await L.admit(db, cand({ model: 'm-judge', task_class: 'screening', decision: true, sample: sample(120, 20) }), { now: NOW });
  assert.deepEqual([r.admitted, r.stage], [false, 'agreement']);
  const row = one(db, `SELECT n, agree, lower_bound, gate, reason FROM ladder_model_admission WHERE stage='rejected'`);
  assert.ok(near(row.agree, 20 / 120) && row.n === 120 && row.gate === 0.7 && row.lower_bound < row.agree);
  assert.match(row.reason, /^agreement: lower bound 0\.11 is under the class gate 0\.7$/);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM ladder_model_task_matrix WHERE task_class='screening'`).n, 0);
  // the same model stays admissible for a class where it is not a decision model
  assert.equal((await L.admit(db, cand({ model: 'm-judge', task_class: 'summaries' }), { now: NOW })).admitted, true);
  // the gate is met by the lower bound, not the share: 0.72 of 100 has a lower bound under 0.7
  const edge = await L.admit(db, cand({ model: 'm-edge', task_class: 'screening', decision: true, sample: { n: 100, agree: 72 } }), { now: NOW });
  assert.equal(edge.admitted, false);
  const few = await L.admit(db, cand({ model: 'm-few', task_class: 'screening', decision: true, sample: sample(29, 29) }), { now: NOW });
  assert.match(few.reason, /inconclusive: 29 labelled answers, fewer than 30/);
  const ok = await L.admit(db, cand({ model: 'm-good', task_class: 'screening', decision: true, sample: sample(300, 264) }), { now: NOW });
  assert.equal(ok.admitted, true);
  assert.ok(near(one(db, `SELECT agreement FROM ladder_model_task_matrix WHERE model='m-good'`).agreement, 0.88));
  assert.ok(near(L.wilsonLower(264, 300), 0.8384, 1e-3));
});

async function ladder(db) {
  await L.admit(db, cand({ model: 'm-free', rung: 0, unit_cost: 0 }), { now: NOW });
  await L.admit(db, cand({ model: 'm-cheap', rung: 1, unit_cost: 0.002 }), { now: NOW });
  await L.admit(db, cand({ model: 'm-frontier', rung: 2, unit_cost: 0.02 }), { now: NOW });
}
const byLength = (min) => (out) => (out === '' ? { ok: false, signal: 'empty' } : out.length < min ? { ok: false, signal: 'schema' } : { ok: true });

test('US-09-R09 escalation moves one rung per measured failure, records the signal in the attempt row, is bounded, and a failed task is filed, not retried', async () => {
  const db = mk();
  await ladder(db);
  const answers = { 'm-free': '', 'm-cheap': 'short', 'm-frontier': 'a long enough answer' };
  const calls = [];
  const runModel = async (row) => { calls.push(row.model); return { output: answers[row.model] }; };
  const r = await L.cascade(db, { task_id: 'T1', task_class: 'triage', need: { tool_calls: true }, run: runModel, validate: byLength(10) }, { now: NOW });
  assert.deepEqual([r.ok, r.model, r.rung, r.attempts], [true, 'm-frontier', 2, 3]);
  assert.deepEqual(calls, ['m-free', 'm-cheap', 'm-frontier']);
  assert.deepEqual(rows(db, `SELECT rung, verified, signal FROM ladder_attempts WHERE task_id='T1' ORDER BY id`).map(a => [a.rung, a.verified, a.signal]), [[0, 0, 'empty'], [1, 0, 'schema'], [2, 1, null]]);
  // bounded: with one retry allowed the task stops after two attempts and becomes a work item
  const b = await L.cascade(db, { task_id: 'T2', task_class: 'triage', run: runModel, validate: byLength(10), maxRetries: 1 }, { now: NOW });
  assert.deepEqual([b.ok, b.attempts, b.item], [false, 2, 'TASKFAIL-T2']);
  assert.equal(one(db, `SELECT status FROM items WHERE id='TASKFAIL-T2'`).status, 'ready');
  // a failure without a measured signal does not escalate
  const u = await L.cascade(db, { task_id: 'T3', task_class: 'triage', run: runModel, validate: () => ({ ok: false, signal: 'felt wrong' }) }, { now: NOW });
  assert.deepEqual([u.ok, u.attempts, u.last.model], [false, 1, 'm-free']);
  // a provider error is a recorded signal
  const p = await L.cascade(db, { task_id: 'T4', task_class: 'triage', run: async (row) => { if (row.rung === 0) throw new Error('503'); return { output: 'a long enough answer' }; }, validate: byLength(10) }, { now: NOW });
  assert.deepEqual([p.ok, p.model], [true, 'm-cheap']);
  assert.equal(one(db, `SELECT signal FROM ladder_attempts WHERE task_id='T4' AND rung=0`).signal, 'provider_error');
  assert.equal((await L.cascade(db, { task_id: 'T5', task_class: 'no-such-class', run: runModel, validate: byLength(1) })).refusal, 'no_capable_model');
});

test('US-09-T03, US-09-R07 a breached cap steers the task to a free rung and does not end it; with no free rung the task is queued, not failed', async () => {
  const db = mk();
  await ladder(db);
  const calls = [];
  const r = await L.cascade(db, { task_id: 'C1', task_class: 'triage', capBreached: true, run: async (row) => { calls.push(row.model); return { output: 'served by the free rung' }; }, validate: byLength(5) }, { now: NOW });
  assert.deepEqual([r.ok, r.model, r.steered, calls], [true, 'm-free', true, ['m-free']]);
  assert.equal(one(db, `SELECT steered FROM ladder_attempts WHERE task_id='C1'`).steered, 1);
  const paidOnly = mk();
  await L.admit(paidOnly, cand(), { now: NOW });
  const q = await L.cascade(paidOnly, { task_id: 'C2', task_class: 'triage', capBreached: true, run: async () => { throw new Error('a paid call must not be made'); }, validate: byLength(5) }, { now: NOW });
  assert.deepEqual([q.ok, q.refusal, q.queued], [false, 'cap_breached_no_free_rung', true]);
  assert.equal(one(paidOnly, `SELECT COUNT(*) AS n FROM ladder_attempts`).n, 0);
});

test('cost-per-task view, worked example of section 4: 100 tasks, cheap passes 60, frontier passes 39 of 40: 0.0101 per verified outcome, escalation rate 0.40', async () => {
  const db = mk();
  await L.admit(db, cand({ model: 'm-cheap', rung: 1, unit_cost: 0.002 }), { now: NOW });
  await L.admit(db, cand({ model: 'm-frontier', rung: 2, unit_cost: 0.02 }), { now: NOW });
  for (let i = 0; i < 100; i++) {
    const runModel = async (row) => ({ output: row.model === 'm-cheap' ? (i < 60 ? 'ok' : '') : (i === 99 ? '' : 'ok') });
    await L.cascade(db, { task_id: `W${i}`, task_class: 'triage', run: runModel, validate: (o) => (o ? { ok: true } : { ok: false, signal: 'empty' }) }, { now: NOW });
  }
  const v = await L.costPerTask(db, 'triage');
  assert.deepEqual([v.tasks, v.verified, v.attempts], [100, 99, 140]);
  assert.ok(near(v.spend, 1.0) && near(v.cost_per_verified_outcome, 1.0 / 99) && near(v.escalation_rate, 0.40));
  assert.equal(v.cost_per_verified_outcome.toFixed(4), '0.0101');
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM items WHERE id LIKE 'TASKFAIL-%'`).n, 1);
  assert.equal((await L.costPerTask(db)).length, 1);
});

const CHECKS = [{ name: 'json', check: (o) => { JSON.parse(o); return true; } }, { name: 'has-title', check: (o) => typeof JSON.parse(o).title === 'string' }];

test('draft-then-verify (L6): the frontier model repairs only when a deterministic check fails, once; a repair that still fails is filed', async () => {
  const db = mk();
  let repairs = 0;
  const repair = async (out, failed) => { repairs++; return { output: '{"title":"fixed"}', cost: 0.02, model: 'm-frontier', failed }; };
  const pass = await L.draftThenVerify(db, { task_id: 'D1', task_class: 'summaries', checks: CHECKS, draft: async () => ({ output: '{"title":"a"}', cost: 0.002, model: 'm-cheap' }), repair }, { now: NOW });
  assert.deepEqual([pass.ok, pass.repaired, pass.model, pass.cost, repairs], [true, false, 'm-cheap', 0.002, 0]);
  const fixed = await L.draftThenVerify(db, { task_id: 'D2', task_class: 'summaries', checks: CHECKS, draft: async () => ({ output: '{"name":"a"}', cost: 0.002, model: 'm-cheap' }), repair }, { now: NOW });
  assert.deepEqual([fixed.ok, fixed.repaired, fixed.failed_checks, fixed.output, repairs], [true, true, ['has-title'], '{"title":"fixed"}', 1]);
  assert.ok(near(fixed.cost, 0.022));
  const bad = await L.draftThenVerify(db, { task_id: 'D3', task_class: 'summaries', checks: CHECKS, draft: async () => ({ output: 'not json', cost: 0.002, model: 'm-cheap' }), repair: async () => { repairs++; return { output: '{"still":"wrong"}', cost: 0.02, model: 'm-frontier' }; } }, { now: NOW });
  assert.deepEqual([bad.ok, bad.failed_checks, bad.item, repairs], [false, ['has-title'], 'TASKFAIL-D3', 2]);
  assert.deepEqual(rows(db, `SELECT task_id, layer, verified, signal FROM ladder_attempts ORDER BY id`).map(a => [a.task_id, a.layer, a.verified, a.signal]),
    [['D1', 'draft', 1, null], ['D2', 'draft', 0, 'check:has-title'], ['D2', 'repair', 1, null], ['D3', 'draft', 0, 'check:json,has-title'], ['D3', 'repair', 0, 'check:has-title']]);
  const v = await L.costPerTask(db, 'summaries');
  assert.deepEqual([v.tasks, v.verified], [3, 2]); assert.ok(near(v.cost_per_verified_outcome, 0.046 / 2));
  await assert.rejects(L.draftThenVerify(db, { task_id: 'D4', task_class: 'summaries', checks: [], draft: async () => ({}), repair }), /deterministic check/);
});

test('shadow sampling: a stable sample of about 5% of decisions, each compared with the label', async () => {
  const keys = Array.from({ length: 20000 }, (_, i) => `decision-${i}`);
  const picked = keys.filter(k => L.shouldShadow(k));
  assert.ok(picked.length > 800 && picked.length < 1200, `picked ${picked.length} of 20000`);
  assert.deepEqual(keys.filter(k => L.shouldShadow(k)), picked, 'the same key is always in or always out');
  assert.equal(keys.filter(k => L.shouldShadow(k, 0)).length, 0);
  const db = mk();
  assert.deepEqual(await L.recordShadow(db, { model: 'm', task_class: 'screening', decision_ref: 'decision-1', model_answer: 'A', label: 'A' }, { now: NOW }), { agree: true });
  await L.recordShadow(db, { model: 'm', task_class: 'screening', model_answer: 'B', label: 'A' }, { now: NOW });
  assert.deepEqual(await L.rollingAgreement(db, { model: 'm', task_class: 'screening' }), { n: 2, agreement: 0.5 });
});

test('demotion step: rolling agreement under gate minus margin, a canary failing twice, or a floor change removes the row, records it and files an item', async () => {
  const db = mk();
  await L.admit(db, cand({ model: 'm-judge', task_class: 'screening', decision: true, sample: sample(300, 264) }), { now: NOW });
  await L.admit(db, cand({ model: 'm-tools', task_class: 'triage' }), { now: NOW });
  await L.admit(db, cand({ model: 'm-turbo', task_class: 'triage', rung: 2 }), { now: NOW });
  assert.deepEqual(await L.monitor(db, { now: NOW }), []);
  // 0.66 over 50 is inside the margin (gate 0.7 - 0.05); 0.60 is under it
  const shadow = async (n, agree) => { for (let i = 0; i < n; i++) await L.recordShadow(db, { model: 'm-judge', task_class: 'screening', model_answer: i < agree ? 'A' : 'B', label: 'A' }, { now: NOW }); };
  await shadow(50, 33);
  assert.deepEqual(await L.monitor(db, { now: NOW }), []);
  await shadow(20, 12); // too few alone, but the window now holds 70 at 45/70 = 0.64
  const d1 = await L.monitor(db, { now: NOW });
  assert.deepEqual(d1.map(d => [d.model, d.task_class]), [['m-judge', 'screening']]);
  assert.match(d1[0].reason, /^rolling agreement 0\.64 over 70 is under gate 0\.7 minus 0\.05$/);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM ladder_model_task_matrix WHERE model='m-judge'`).n, 0);
  assert.deepEqual({ ...one(db, `SELECT stage, n, gate FROM ladder_model_admission WHERE model='m-judge' ORDER BY id DESC LIMIT 1`) }, { stage: 'demoted', n: 70, gate: 0.7 });
  assert.equal(one(db, `SELECT priority FROM items WHERE id=?`, d1[0].item).priority, 0, 'the class has no admitted model left: top priority');
  assert.equal((await L.canRoute(db, { task_class: 'screening', model: 'm-judge' })).refusal, 'not_admitted');
  // canary: one failure does not demote, two in a row do
  await L.recordCanary(db, { model: 'm-tools', task_class: 'triage', tool_calls: false, schema: true, need: { tool_calls: true } }, { now: NOW });
  assert.deepEqual(await L.monitor(db, { now: NOW }), []);
  assert.equal(one(db, `SELECT canary_tool_calls FROM ladder_model_task_matrix WHERE model='m-tools'`).canary_tool_calls, 0);
  await L.recordCanary(db, { model: 'm-tools', task_class: 'triage', tool_calls: false, schema: true, need: { tool_calls: true } }, { now: NOW });
  assert.deepEqual((await L.monitor(db, { now: NOW })).map(d => [d.model, d.reason]), [['m-tools', 'canary failed twice']]);
  // the floor list changes
  await L.setFloor(db, [{ pattern: '-turbo$', reason: 'quantized fast variant' }]);
  const s = await L.step({ db, now: NOW });
  assert.deepEqual([s.demoted, s.items], [1, ['MODEL-DEMOTED-triage-m-turbo-2026-11-11']]);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM ladder_model_task_matrix`).n, 0);
});
