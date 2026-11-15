// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// US-SPEC-13: service-level policy (R07 to R10, T03), weekly audit, step budgets (R11, R12, T04), six-term F, monthly autonomy card (T05).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createSla, CARD_LIMITS } from './index.js';
import { createConsoleL3, LIMITS_MUST_MENTION } from '../console-l3/index.js';
import { evalProbe } from '../src/tick.js';

const MIG = [fileURLToPath(new URL('./migrations/', import.meta.url)), fileURLToPath(new URL('../console-l3/migrations/', import.meta.url))];
const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);
const D = 86400e3; const H = 3600e3;
const stamp = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const mk = (config = {}) => { const db = makeDb(MIG); const t = { v: T0 }; const now = () => t.v; return { db, t, sla: createSla({ db, now, config }), l3: createConsoleL3({ db, now }) }; };
const item = (db, id, { created = T0, status = 'open', priority = 10, owner = 'staff', blocker = null } = {}) =>
  db.raw.prepare(`INSERT INTO items (id,title,owner_role,done_check,status,priority,created_at,updated_at,blocker,disposition) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, id, owner, 'x', status, priority, stamp(created), stamp(created), blocker, status === 'done' ? 'done with evidence' : null);
const row = (db, id) => db.raw.prepare(`SELECT * FROM sla_rows WHERE item_id=?`).get(id);
const get = (db, sql, ...a) => db.raw.prepare(sql).get(...a);

test('US-13-R07: every open row gets a severity and a due date no later than open date plus the time for its severity', async () => {
  const { db, sla } = mk({ accelerate: false });
  item(db, 'A'); item(db, 'B'); item(db, 'C'); item(db, 'Z', { status: 'done' });
  await sla.classify('A', { severity: 'SEV1' }); await sla.classify('B', { severity: 'SEV2', due_at: T0 + 10 * D });
  const r = await sla.recompute();
  assert.equal(r.rows, 3); assert.equal(r.added, 1); assert.equal(r.tightened, 1);
  assert.equal(row(db, 'A').due_at, stamp(T0 + 24 * H));
  assert.equal(row(db, 'B').due_at, stamp(T0 + 72 * H));
  assert.equal(row(db, 'C').severity, 'SEV3'); assert.equal(row(db, 'C').due_at, stamp(T0 + 7 * D));
  assert.equal(row(db, 'Z'), undefined);
  assert.deepEqual((await sla.classify('A', { severity: 'SEV9' })).ok, false);
  assert.deepEqual(await sla.recompute(), { rows: 3, added: 0, tightened: 0, capped: 0, accelerated: 0, raised: 0, notified: 0 });
});

test('US-13-T03 and R08: an open SEV3 row due in 30 days is set to now plus the SEV3 cap; the three exemptions keep their date', async () => {
  const { db, t, sla } = mk();
  for (const id of ['A', 'CAL', 'EXT', 'DRAIN', 'OLD4']) item(db, id);
  await sla.classify('A', { severity: 'SEV3', due_at: T0 + 30 * D });
  await sla.classify('CAL', { due_at: T0 + 40 * D, exempt: 'calendar', exempt_reason: 'annual filing date' });
  await sla.classify('EXT', { due_at: T0 + 50 * D, exempt: 'external_event', exempt_reason: 'waits for the provider release' });
  assert.equal((await sla.classify('DRAIN', { due_at: T0 + 20 * D, exempt: 'rate_limited_drain', exempt_reason: 'slow' })).ok, false);
  await sla.classify('DRAIN', { due_at: T0 + 20 * D, exempt: 'rate_limited_drain', exempt_reason: '329 records at about 18 per day' });
  assert.equal((await sla.classify('A', { exempt: 'because' })).ok, false);
  assert.equal((await sla.classify('A', { exempt: 'calendar' })).ok, false);
  await sla.recompute();
  assert.equal(row(db, 'A').due_at, stamp(T0 + 7 * D));
  assert.equal(row(db, 'CAL').due_at, stamp(T0 + 40 * D));
  assert.equal(row(db, 'EXT').due_at, stamp(T0 + 50 * D));
  assert.equal(row(db, 'DRAIN').due_at, stamp(T0 + 20 * D));
  const far = get(db, `SELECT COUNT(*) AS n FROM sla_rows WHERE exempt IS NULL AND due_at > ?`, stamp(T0 + 14 * D)).n;
  assert.equal(far, 0);
  // the hard cap itself: a row whose stored due date is beyond 14 days (policy widened earlier) is pulled to the SEV3 cap
  const wide = mk({ severity_hours: { SEV1: 24, SEV2: 72, SEV3: 168, SEV4: 24 * 40 }, accelerate: false });
  item(wide.db, 'W'); await wide.sla.classify('W', { severity: 'SEV4' });
  assert.equal((await wide.sla.recompute()).capped, 1);
  assert.equal(row(wide.db, 'W').due_at, stamp(T0 + 7 * D));
  // acceleration: an agent-owned SEV4 row beyond the SEV3 limit is pulled to it; a row owned by the person is not
  item(db, 'S4'); item(db, 'MINE', { owner: 'owner' });
  await sla.classify('S4', { severity: 'SEV4' }); await sla.classify('MINE', { severity: 'SEV4' });
  assert.equal((await sla.recompute()).accelerated, 1);
  assert.equal(row(db, 'S4').due_at, stamp(T0 + 7 * D)); assert.equal(row(db, 'MINE').due_at, stamp(T0 + 14 * D));
  t.v += D; await sla.recompute();
  assert.equal(row(db, 'S4').due_at, stamp(T0 + 7 * D), 'a due date never slides later');
});

test('US-13-R09: a row past due is raised one priority level and the manager notified, once per missed date', async () => {
  const { db, t, sla } = mk();
  item(db, 'A', { priority: 10 }); item(db, 'TOP', { priority: 0 });
  await sla.classify('A', { severity: 'SEV1' }); await sla.classify('TOP', { severity: 'SEV1' });
  await sla.recompute();
  assert.equal(get(db, `SELECT priority FROM items WHERE id='A'`).priority, 10);
  t.v += 25 * H;
  const r = await sla.recompute();
  assert.equal(r.raised, 2); assert.equal(r.notified, 2);
  assert.equal(get(db, `SELECT priority FROM items WHERE id='A'`).priority, 9);
  assert.equal(get(db, `SELECT priority FROM items WHERE id='TOP'`).priority, 0);
  const n = get(db, `SELECT role, text FROM sla_notices WHERE item_id='A'`);
  assert.equal(n.role, 'portfolio-manager'); assert.match(n.text, /SEV1.*priority raised/);
  t.v += H; assert.equal((await sla.recompute()).raised, 0);
  assert.equal(get(db, `SELECT priority FROM items WHERE id='A'`).priority, 9);
  assert.equal((await sla.summary()).past_due, 2);
});

test('US-13-R10: items waiting on a person is a metric with target zero; a breach files one item whose probe closes it', async () => {
  const { db, sla } = mk();
  assert.deepEqual((await sla.waitingOnPerson()).breach, false);
  db.raw.exec(`INSERT INTO gate_cards (id,what,why_gated,default_in_effect,closing_probe) VALUES ('G1','Approve','money','zero','manual')`);
  item(db, 'HELD', { status: 'blocked', blocker: 'Out of scope by default' });
  item(db, 'PARKED', { status: 'blocked', blocker: 'waiting on probe: env:X (absent)' });
  const w = await sla.waitingOnPerson(); await sla.waitingOnPerson();
  assert.equal(w.value, 2); assert.equal(w.target, 0); assert.equal(w.breach, true);
  const it = get(db, `SELECT * FROM items WHERE id='SLA-WAITING-ON-A-PERSON'`);
  assert.ok(it); assert.equal(get(db, `SELECT COUNT(*) AS n FROM items WHERE id LIKE 'SLA-WAITING%'`).n, 1);
  assert.equal((await evalProbe(db, {}, it)).ok, false);
  db.raw.exec(`UPDATE gate_cards SET status='closed'; UPDATE items SET status='done', disposition='enabled' WHERE id='HELD'`);
  assert.equal((await evalProbe(db, {}, it)).ok, true);
  assert.deepEqual(db.raw.prepare(`SELECT value, target FROM sla_metrics ORDER BY id`).all().map(r => [r.value, r.target]), [[0, 0], [2, 0], [2, 0]]);
});

test('weekly audit: an open row with neither a due date nor an executor fails and gets one item; the audit is stored', async () => {
  const { db, sla } = mk();
  db.raw.exec(`INSERT INTO roles (id, role, model) VALUES ('ops-1', 'operations', 'small')`);
  item(db, 'HAS-ROLE', { owner: 'operations' }); item(db, 'ORPHAN', { owner: 'nobody' }); item(db, 'DATED', { owner: 'nobody' });
  await sla.classify('DATED', { severity: 'SEV2' });
  const a = await sla.weeklyAudit();
  assert.equal(a.checked, 3); assert.equal(a.failing, 1);
  assert.deepEqual(a.findings.find(f => f.item_id === 'ORPHAN'), { item_id: 'ORPHAN', problem: 'no due date and no executor' });
  assert.equal(a.findings.find(f => f.item_id === 'DATED').problem, 'no executor for its owner role');
  assert.ok(get(db, `SELECT id FROM items WHERE id='SLA-AUDIT-ORPHAN'`));
  assert.equal(get(db, `SELECT failing FROM sla_audits`).failing, 1);
});

test('US-13-T04 and R11: step runs are timed from the table; 5 h of a 4 h budget files an item, 9 h exactly one blocking question', async () => {
  const { db, t, sla, l3 } = mk();
  assert.equal((await sla.startStep({ process: 'change', step: 'review' })).ok, false);
  await sla.defineProcess({ process: 'change', done_check: 'merged and probed', steps: [{ step: 'review', budget_hours: 4, paths: ['reviewer agent', 'second model'] }, { step: 'deploy', budget_hours: 1, paths: ['canary', 'direct with revert'] }] });
  const s = await sla.startStep({ process: 'change', step: 'review', ref: 'ITEM-1' });
  const d = await sla.startStep({ process: 'change', step: 'deploy' }); await sla.finishStep(d.id);
  t.v += 5 * H;
  assert.deepEqual((await sla.step({}, { l3 })).step_budget, [{ key: 'CHANGE-REVIEW', kind: 'item' }]);
  assert.equal(get(db, `SELECT COUNT(*) AS n FROM gate_cards`).n, 0);
  t.v += 4 * H;
  await sla.step({}, { l3 }); await sla.step({}, { l3 });
  assert.equal(get(db, `SELECT COUNT(*) AS n FROM gate_cards WHERE id='stepq-change-review'`).n, 1);
  assert.equal(get(db, `SELECT COUNT(*) AS n FROM items WHERE id='STEPBUDGET-CHANGE-REVIEW'`).n, 1);
  assert.equal(get(db, `SELECT COUNT(*) AS n FROM items WHERE id LIKE 'STEPBUDGET-CHANGE-DEPLOY%'`).n, 0, 'a finished step is not a breach');
  await sla.finishStep(s.id);
  assert.deepEqual(await sla.stepRuns(), []);
});

test('US-13-R12: a process defines its done check once; a step with one path is a gap and is filed once', async () => {
  const { db, sla } = mk();
  assert.equal((await sla.defineProcess({ process: 'p', steps: [{ step: 'a', budget_hours: 1 }] })).ok, false);
  await sla.defineProcess({ process: 'publish', done_check: 'page live and probed', steps: [{ step: 'build', budget_hours: 1, paths: ['ci', 'ci'] }, { step: 'ship', budget_hours: 1, paths: ['primary', 'workaround'] }] });
  assert.deepEqual(await sla.processGaps(), [{ process: 'publish', step: 'build', paths: 2 }]);
  await sla.processGaps();
  assert.equal(get(db, `SELECT COUNT(*) AS n FROM items WHERE id LIKE 'SLA-PATHGAP-%'`).n, 1);
});

test('six-term F: computed from tables with the weights in effect, stored with the triad, marked uncalibrated; unmeasured terms are named', async () => {
  const { db, t, sla } = mk({ weights: { loop_closure_rate: 10, drift_count: 2, human_interventions: 1, cost_overrun: 1, integration_gap: 1, throughput: 0.5 } });
  db.raw.exec(`INSERT INTO tick_runs (started_at,finished_at,steps_completed,steps_total) VALUES ('${stamp(T0 - H)}','${stamp(T0 - H)}',8,8),('${stamp(T0 - 2 * H)}','${stamp(T0 - 2 * H)}',8,8),('${stamp(T0 - 3 * H)}',NULL,3,8),('${stamp(T0 - 4 * H)}','${stamp(T0 - 4 * H)}',8,8);
    INSERT INTO console_actions (kind, ref, at) VALUES ('card_done','G0','${stamp(T0 - H)}'),('ask','ASK-1','${stamp(T0 - H)}');
    INSERT INTO gate_cards (id,what,why_gated,default_in_effect,closing_probe) VALUES ('G1','Approve','money','zero','manual')`);
  item(db, 'D1', { status: 'done' }); item(db, 'D2', { status: 'done' }); item(db, 'OLD', { status: 'done', created: T0 - 90 * D });
  const o = await sla.objective({ drift_count: 3 });
  assert.equal(o.terms.loop_closure_rate.value, 0.75); assert.equal(o.terms.human_interventions.value, 1); assert.equal(o.terms.throughput.value, 2);
  assert.equal(o.f, 10 * 0.75 - 2 * 3 - 1 * 1 - 0 - 0 + 0.5 * 2);
  assert.deepEqual(o.unmeasured, ['cost_overrun', 'integration_gap']); assert.equal(o.calibrated, false);
  assert.deepEqual(o.triad, { human_gated: 1, drift: 3, self_healing: true }); assert.equal(o.good, null);
  db.raw.exec(`UPDATE gate_cards SET status='closed'`); t.v += H;
  const o2 = await sla.objective({ drift_count: 0 });
  assert.equal(o2.good, 1); assert.deepEqual(o2.triad, { human_gated: 0, drift: 0, self_healing: true });
  db.raw.exec(`INSERT INTO gate_cards (id,what,why_gated,default_in_effect,closing_probe) VALUES ('G2','Sign','identity','unsigned','manual')`);
  assert.equal((await sla.objective({ drift_count: 0 })).good, 0);
  const stored = get(db, `SELECT f, calibrated, weights FROM sla_objective ORDER BY id LIMIT 1`);
  assert.equal(stored.f, o.f); assert.equal(stored.calibrated, 0); assert.equal(JSON.parse(stored.weights).loop_closure_rate, 10);
});

const seedMonth = db => {
  for (let i = 0; i < 10; i++) db.raw.prepare(`INSERT INTO tick_runs (started_at,finished_at,steps_completed,steps_total) VALUES (?,?,?,8)`).run(stamp(T0 - (i + 1) * H), stamp(T0 - (i + 1) * H), i < 8 ? 8 : 5);
  db.raw.exec(`INSERT INTO outcomes (item_id,surface,action_class,result,at) VALUES ('A','s','merge','verified','${stamp(T0 - H)}'),('A','s','merge','verified','${stamp(T0 - H)}'),('A','s','merge','failed','${stamp(T0 - H)}'),('A','s','merge','verified','${stamp(T0 - H)}');
    INSERT INTO predictions (id,item_id,metric,op,target,due_at,verdict) VALUES ('P1','A','m','>=',1,'${stamp(T0 - D)}','hit'),('P2','A','m','>=',1,'${stamp(T0 - D)}','hit');
    INSERT INTO trust_ledger (surface,action_class,rung,reliability,outcomes,updated_at) VALUES ('s','merge','delegated',0.8,4,'${stamp(T0)}')`);
};

test('monthly autonomy card: ten dimensions scored 0 to 5 from tables, each with evidence, confidence and status; limits stated; three largest gaps filed', async () => {
  const { db, sla, l3 } = mk();
  seedMonth(db); item(db, 'A'); item(db, 'DONE', { status: 'done' });
  assert.match(CARD_LIMITS, LIMITS_MUST_MENTION);
  const c = await sla.recomputeAutonomyCard({ l3 });
  assert.equal(c.ok, true); assert.equal(c.dimensions.length, 10);
  const by = Object.fromEntries(c.dimensions.map(d => [d.dimension, d]));
  assert.equal(by.check_completion.score, 4); assert.match(by.check_completion.evidence, /tick_runs: 8 of 10/); assert.equal(by.check_completion.confidence, 'medium');
  assert.equal(by.verified_outcomes.score, 3.8); assert.equal(by.verified_outcomes.confidence, 'low');
  assert.equal(by.prediction_accuracy.score, 5); assert.match(by.prediction_accuracy.status, /^gap: a top score is not accepted/);
  assert.equal(by.dispatch_success.score, 0); assert.match(by.dispatch_success.status, /^unmeasured/);
  assert.equal(by.earned_trust.score, 1.7);
  for (const d of c.dimensions) { assert.ok(d.score >= 0 && d.score <= 5); assert.ok(d.evidence && d.confidence && d.status); }
  const card = await l3.reportCard('autonomy');
  assert.equal(card.scores.length, 10); assert.match(card.limits, /grades itself/);
  assert.equal(Math.round(card.overall * 100) / 100, c.overall);
  assert.equal(c.kaizen.length, 3);
  assert.equal(get(db, `SELECT COUNT(*) AS n FROM items WHERE id LIKE 'KAIZEN-AUTONOMY-%-2026-11'`).n, 3);
  assert.equal((await sla.recomputeAutonomyCard({})).ok, false);
});

test('US-13-T05 and R05: a dimension that falls 0.6 on the recomputed card with no cause becomes a work item; a stated cause does not', async () => {
  const { db, t, sla, l3 } = mk();
  seedMonth(db); item(db, 'A');
  await sla.recomputeAutonomyCard({ l3 });
  t.v += 30 * D;
  for (let i = 0; i < 10; i++) db.raw.prepare(`INSERT INTO tick_runs (started_at,finished_at,steps_completed,steps_total) VALUES (?,?,?,8)`).run(stamp(t.v - (i + 1) * H), stamp(t.v - (i + 1) * H), i < 6 ? 8 : 5);
  const c = await sla.recomputeAutonomyCard({ l3, causes: { verified_outcomes: 'no outcomes were recorded this month: the window is empty' } });
  assert.ok(c.fell.includes('L3-DROP-AUTONOMY-CHECK-COMPLETION'));
  assert.ok(!c.fell.includes('L3-DROP-AUTONOMY-VERIFIED-OUTCOMES'));
  assert.ok(get(db, `SELECT id FROM items WHERE id='L3-DROP-AUTONOMY-CHECK-COMPLETION'`));
});

test('step(): recompute runs every tick, the audit weekly and the card monthly, by dated register rows', async () => {
  const { db, t, sla, l3 } = mk();
  seedMonth(db); item(db, 'A');
  const ctx = { notes: [] };
  const first = await sla.step(ctx, { l3 });
  assert.ok(first.audit && first.card && first.objective); assert.match(ctx.notes[0], /^sla: 1 open rows/);
  t.v += D;
  const next = await sla.step(ctx, { l3 });
  assert.ok(!next.audit && !next.card); assert.equal(next.waiting.value, 0);
  t.v += 6 * D + H;
  assert.ok((await sla.step(ctx, { l3 })).audit);
  t.v += 24 * D;
  assert.ok((await sla.step(ctx, { l3 })).card);
  assert.equal(get(db, `SELECT COUNT(*) AS n FROM l3_cards`).n, 2);
  assert.equal(get(db, `SELECT next_due_at FROM sla_register WHERE name='autonomy_card'`).next_due_at, stamp(t.v + 30 * D));
  assert.ok((await sla.step({}, {})).sla, 'runs without the report-card writer');
});
