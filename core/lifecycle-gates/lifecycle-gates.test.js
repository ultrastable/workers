// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb } from '../_shared/testdb.js';
import { runTick } from '../src/tick.js';
import { MIGRATIONS_DIR as KERNEL_DIR, CATALOG, reviewArtifact, recordReadback, registerMetric, readMetric, recordDecision, evaluateDecision, amendArtifact } from '../kernel/index.js';
import {
  MIGRATIONS_DIR, selectMode, requiredArtifacts, cadence, checkForm, submitTailored, startProject, advance, recordDeliverable, runDeliverableProbe,
  startIteration, endIteration, recordRetrospective, setCommunicationPlan, produceStatusReport, refreshStatusReports, classifyScope, decidePack, requestWork, lifecycleStep,
} from './index.js';

const policy = JSON.parse(readFileSync(new URL('../../autonomy/policy.json', import.meta.url), 'utf8'));
const config = { org_slug: 't', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy };
const NOW = Date.parse('2026-11-10T12:00:00Z'), HOUR = 3600e3, DAY = 24 * HOUR;
const ts = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const setup = () => { const db = makeDb([KERNEL_DIR, MIGRATIONS_DIR]); db.raw.exec(`CREATE TABLE t_vals (k TEXT PRIMARY KEY, v REAL)`); return db; };
const one = (db, sql, ...a) => db.raw.prepare(sql).get(...a);
const rows = (db, sql, ...a) => db.raw.prepare(sql).all(...a);
const item = (db, id, o = {}) => db.raw.prepare(`INSERT INTO items (id, title, owner_role, done_check, closing_probe, priority, status, project, disposition, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
  .run(id, id, 'staff', 'x', 'probe', o.priority ?? 50, o.status || 'ready', o.project ?? null, o.disposition ?? null, ts(o.at ?? NOW));

const CHARTER = { objective: 'a booking page that keeps working', definition_of_done: 'a visitor can book a slot', definition_of_done_probe: `SELECT COUNT(*) AS value FROM items WHERE status = 'done'`,
  primary_metric: 'bookings_per_week', guard_metrics: ['error_rate'], cap: '20 USD a month', authority_limits: 'reversible changes only', manager_role: 'project-manager' };
const CONTENT = {
  'A-INI-1': { want_verbatim: 'I want people to book me online', for_whom: 'my clients', first_outcomes: ['a booking page'], constraints: 'no card payments' },
  'A-INI-2': CHARTER, 'A-INI-6': { mode: 'set by the rule', reason: 'see lifecycle_mode_decisions' },
  'A-PLN-4': { items: ['B-1'], roadmap: [{ size: 'S', goal: 'book a slot', user: 'client', success_metric: 'bookings_per_week', closing_probe: 'SELECT 1 AS value' }] },
  'A-PLN-6': { capacity_per_role: { staff: 2 }, plus_share: 0.2, spend_cap: '20 USD a month' },
  'A-PLN-9': { what: 'the four-line report', period_h: 24, form: 'console' },
};
const contentFor = (mode, kind) => CONTENT[kind] ?? (kind === 'A-PLN-5'
  ? { predictive: { milestones: [{ name: 'launch', date: '2026-12-01' }], dependencies: ['B-1 before B-2'] }, agile: { iteration_days: 7, forecast: '3 iterations' }, hybrid: { milestones: [{ name: 'launch', date: '2026-12-01' }], iteration_days: 7 } }[mode]
  : { note: `${kind} record` });
async function fill(db, project, phase, mode, { skip = [] } = {}) {
  for (const c of CATALOG.filter(c => c.phase === phase && !skip.includes(c.kind))) {
    await submitTailored(db, { project_id: project, kind: c.kind, path_or_ref: `docs/${project}/${c.kind}.md`, content: contentFor(mode, c.kind), produced_by: 'doer-1', produced_model: 'alpha-1', now: NOW });
    await reviewArtifact(db, { project_id: project, kind: c.kind, reviewer: 'reviewer-1', reviewer_model: 'beta-1', verdict: 'approved', evidence: 'read and checked' });
  }
}
// A project taken to executing, in the given mode.
async function executing(db, id, mode, base = NOW) {
  await startProject(db, { id, name: id, override: { mode, reason: 'test fixture', decided_by: 'portfolio-manager' }, now: base });
  await fill(db, id, 'initiating', mode);
  assert.equal((await advance(db, id, 'planning', { readiness: async () => ({ score: 0.9 }), now: NOW })).ok, true);
  await fill(db, id, 'planning', mode); await recordReadback(db, id, NOW); item(db, `${id}-W1`, { project: id });
  assert.equal((await advance(db, id, 'executing', { now: NOW })).ok, true);
}

test('US-15-R02: the selection rule gives predictive, agile, or hybrid as the default when the person cannot say', () => {
  assert.equal(selectMode({ requirements_stable: true, order_fixed_by_dependencies: true, external_acceptance_milestone: true }).mode, 'predictive');
  assert.equal(selectMode({ requirements_unclear: true, value_by_increments: true }).mode, 'agile');
  assert.equal(selectMode({ requirements_stable: true, order_fixed_by_dependencies: false, external_acceptance_milestone: true }).mode, 'hybrid');
  assert.deepEqual(selectMode({}), { mode: 'hybrid', reason: 'the person could not say: the default' });
  assert.deepEqual(selectMode(), { mode: 'hybrid', reason: 'the person could not say: the default' });
});

test('US-15-R01, US-15-R02: a project starts with the rule\'s mode and its reason; an override is a recorded decision', async () => {
  const db = setup();
  const a = await startProject(db, { id: 'A', name: 'a', answers: { requirements_unclear: true, value_by_increments: true }, now: NOW });
  assert.deepEqual([a.started, a.mode, a.overridden], [true, 'agile', false]);
  const kp = one(db, `SELECT delivery_mode, mode_reason, current_phase FROM kernel_projects WHERE id = 'A'`);
  assert.deepEqual([kp.delivery_mode, kp.current_phase], ['agile', 'initiating']); assert.match(kp.mode_reason, /working increments/);
  await assert.rejects(startProject(db, { id: 'B', name: 'b', answers: {}, override: { mode: 'predictive' } }), /recorded decision/);
  await assert.rejects(startProject(db, { id: 'B', name: 'b', override: { mode: 'waterfall', reason: 'r', decided_by: 'x' } }), /override mode/);
  const b = await startProject(db, { id: 'B', name: 'b', answers: {}, override: { mode: 'predictive', reason: 'a regulator fixes the date', decided_by: 'portfolio-manager' }, now: NOW });
  assert.deepEqual([b.mode, b.overridden], ['predictive', true]);
  const d = one(db, `SELECT * FROM lifecycle_mode_decisions WHERE project_id = 'B'`);
  assert.deepEqual([d.mode, d.rule_mode, d.overridden, d.decided_by], ['predictive', 'hybrid', 1, 'portfolio-manager']); assert.match(d.reason, /regulator fixes the date \(rule gave hybrid/);
});

test('US-15-R03, US-15-R13: every catalog artifact is required in every mode; the mode changes only weight and form', async () => {
  for (const mode of ['predictive', 'agile', 'hybrid']) {
    const req = requiredArtifacts(mode).map(a => a.kind);
    for (const c of CATALOG) assert.ok(req.includes(c.kind), `${mode} omits ${c.kind}`);
    assert.equal(req.includes('A-EXE-4'), mode !== 'predictive');
  }
  assert.equal(cadence('agile').iterations, true); assert.equal(cadence('predictive').iterations, false);
  assert.deepEqual(checkForm('agile', 'A-PLN-5', { iteration_days: 7, forecast: '3 iterations' }), { ok: true, missing: [], problems: [], weight: 'light' });
  assert.deepEqual(checkForm('predictive', 'A-PLN-5', { iteration_days: 7, forecast: '3 iterations' }).missing, ['milestones', 'dependencies']);
  assert.deepEqual(checkForm('hybrid', 'A-PLN-5', { milestones: [{ name: 'm' }] }).missing, ['iteration_days']);
  // a one-page charter is lighter, never shorter on fields; and its definition of done must be a runnable probe
  const { cap, ...noCap } = CHARTER;
  assert.deepEqual(checkForm('agile', 'A-INI-2', noCap).missing, ['cap']);
  assert.match(checkForm('agile', 'A-INI-2', { ...CHARTER, definition_of_done_probe: 'it works when I look at it' }).problems[0], /not a runnable probe/);
  assert.match(checkForm('agile', 'A-PLN-4', { items: ['x'], roadmap: Array(6).fill(CONTENT['A-PLN-4'].roadmap[0]) }).problems[0], /more than five/);
  assert.match(checkForm('agile', 'A-PLN-4', { items: ['x'], roadmap: [{ size: 'S' }] }).problems[0], /lacks goal, user, success_metric, closing_probe/);
  assert.match(checkForm('agile', 'A-PLN-8', {}).problems[0], /no content/);                  // phase theater: an empty artifact
});

test('US-15-R13, T15-1: an agile project cannot enter Executing while a planning artifact is missing or empty; the attempt files items, not an error', async () => {
  const db = setup();
  await startProject(db, { id: 'AG', name: 'ag', answers: { requirements_unclear: true, value_by_increments: true }, now: NOW });
  await fill(db, 'AG', 'initiating', 'agile');
  assert.equal((await advance(db, 'AG', 'planning', { readiness: async () => 0.8, now: NOW })).ok, true);
  await fill(db, 'AG', 'planning', 'agile', { skip: ['A-PLN-5', 'A-PLN-8'] });
  await submitTailored(db, { project_id: 'AG', kind: 'A-PLN-8', path_or_ref: 'docs/AG/quality.md', content: {}, produced_by: 'doer-1', now: NOW });   // exists, but empty
  await reviewArtifact(db, { project_id: 'AG', kind: 'A-PLN-8', reviewer: 'reviewer-1', verdict: 'approved' });
  await recordReadback(db, 'AG', NOW); item(db, 'AG-W1', { project: 'AG' });
  const r = await advance(db, 'AG', 'executing', { now: NOW });
  assert.equal(r.ok, false);
  assert.deepEqual(r.filed.sort(), ['GATE-AG-A-PLN-5', 'GATE-AG-A-PLN-8-check']);
  assert.equal(one(db, `SELECT current_phase FROM kernel_projects WHERE id = 'AG'`).current_phase, 'planning');
  // the light form of the schedule is accepted for an agile project
  await fill(db, 'AG', 'planning', 'agile');
  assert.equal(one(db, `SELECT period_h FROM lifecycle_comm_plans WHERE project_id = 'AG'`).period_h, 24);   // the communication plan sets the report period
  assert.deepEqual(await advance(db, 'AG', 'executing', { now: NOW }), { ok: true, phase: 'executing' });
});

test('G1 (US-15-R04): the charter\'s definition of done must be a runnable probe and the readiness score must reach the threshold; unreadable is not a pass', async () => {
  const db = setup();
  await startProject(db, { id: 'P', name: 'p', now: NOW });
  await fill(db, 'P', 'initiating', 'hybrid');
  const none = await advance(db, 'P', 'planning', { now: NOW });                             // no readiness port
  assert.deepEqual([none.ok, none.filed], [false, ['GATE-P-planning-readiness']]); assert.match(none.reasons[0], /could not be read/);
  assert.match((await advance(db, 'P', 'planning', { readiness: async () => ({ score: 0.4 }), now: NOW })).reasons[0], /0.40 is under the initiation threshold 0.6/);
  assert.match((await advance(db, 'P', 'planning', { readiness: async () => { throw new Error('down'); }, now: NOW })).reasons[0], /could not be read/);
  assert.equal(one(db, `SELECT current_phase FROM kernel_projects WHERE id = 'P'`).current_phase, 'initiating');
  assert.equal((await advance(db, 'P', 'planning', { readiness: async () => ({ score: 0.6 }), now: NOW })).ok, true);
  // T15-3 still holds through this layer: a charter change after G1 is a change request with a revert path
  const cr = await amendArtifact(db, { project_id: 'P', kind: 'A-INI-2', new_ref: 'docs/P/charter-v2.md', summary: 'raise the cap', revert_path: 'restore docs/P/A-INI-2.md', requested_by: 'project-manager', now: NOW });
  assert.equal(one(db, `SELECT revert_path FROM change_requests WHERE id = ?`, cr.change_request_id).revert_path, 'restore docs/P/A-INI-2.md');

  await startProject(db, { id: 'Q', name: 'q', now: NOW });
  for (const c of CATALOG.filter(c => c.phase === 'initiating')) {
    await submitTailored(db, { project_id: 'Q', kind: c.kind, path_or_ref: `docs/Q/${c.kind}.md`, content: c.kind === 'A-INI-2' ? { ...CHARTER, definition_of_done_probe: 'looks good' } : contentFor('hybrid', c.kind), produced_by: 'doer-1', now: NOW });
    await reviewArtifact(db, { project_id: 'Q', kind: c.kind, reviewer: 'reviewer-1', verdict: 'approved' });
  }
  const q = await advance(db, 'Q', 'planning', { readiness: async () => 1, now: NOW });
  assert.deepEqual(q.filed, ['GATE-Q-planning-charter-probe']);
  assert.equal(one(db, `SELECT owner_role FROM items WHERE id = 'GATE-Q-planning-charter-probe'`).owner_role, 'project-manager');
  assert.equal((await advance(db, 'Q', 'planning', { readiness: async () => 1, config: { require_readiness: false }, now: NOW })).ok, false);
});

test('US-15-R14: the portfolio manager does not start a project that would take capacity above the cap; closing a project frees it', async () => {
  const db = setup(); const cap = { config: { portfolio_cap: 10 } };
  assert.equal((await startProject(db, { id: 'A', name: 'a', capacity: 6, now: NOW }, cap)).started, true);
  const b = await startProject(db, { id: 'B', name: 'b', capacity: 5, now: NOW }, cap);
  assert.deepEqual([b.started, b.reason, b.item_id], [false, 'portfolio cap: 6 + 5 > 10', 'CAPACITY-B']);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM kernel_projects WHERE id = 'B'`).n, 0);
  assert.equal(one(db, `SELECT owner_role FROM items WHERE id = 'CAPACITY-B'`).owner_role, 'portfolio-manager');
  assert.equal((await startProject(db, { id: 'C', name: 'c', capacity: 4, now: NOW }, cap)).started, true);   // exactly at the cap
  db.raw.exec(`UPDATE kernel_projects SET current_phase = 'closed' WHERE id = 'A'`);
  assert.equal((await startProject(db, { id: 'B', name: 'b', capacity: 5, now: NOW }, cap)).started, true);
});

test('US-15-R09, T15-5: ending an iteration without a retrospective blocks the next; the retrospective files its improvements as plus items', async () => {
  const db = setup(); await executing(db, 'AG', 'agile');
  item(db, 'AG-W2', { project: 'AG' });
  const i1 = await startIteration(db, { project_id: 'AG', goal: 'a visitor can see free slots', items: ['AG-W1', 'AG-W2'], now: NOW });
  assert.deepEqual([i1.ok, i1.n], [true, 1]);
  assert.match((await startIteration(db, { project_id: 'AG', goal: 'next', now: NOW })).reason, /iteration 1 has not ended/);
  await assert.rejects(endIteration(db, i1.id, { items_done: ['AG-W1'], now: NOW }), /demonstration/);
  await assert.rejects(endIteration(db, i1.id, { items_done: ['OTHER'], demo_result: 'shown', now: NOW }), /not taken in this iteration/);
  await endIteration(db, i1.id, { items_done: ['AG-W1'], demo_result: 'shown to the proxy: slots list renders', now: NOW + 7 * DAY });
  const blocked = await startIteration(db, { project_id: 'AG', goal: 'next', now: NOW + 7 * DAY });
  assert.deepEqual([blocked.ok, blocked.reason, blocked.item_id], [false, 'iteration 1 has no retrospective', 'RETRO-AG-1']);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM lifecycle_iterations WHERE project_id = 'AG'`).n, 1);
  assert.equal(one(db, `SELECT owner_role FROM items WHERE id = 'RETRO-AG-1'`).owner_role, 'project-manager');
  await assert.rejects(recordRetrospective(db, i1.id, { outcome: 'went fine', improvements: [' '] }), /at least one improvement/);
  const retro = await recordRetrospective(db, i1.id, { outcome: 'review came late', improvements: ['review on the day the change lands', 'smaller items'], now: NOW + 7 * DAY });
  assert.deepEqual(retro.items, ['RETROPLUS-AG-1-1', 'RETROPLUS-AG-1-2']);
  const plus = one(db, `SELECT kind, owner_role, title FROM items WHERE id = 'RETROPLUS-AG-1-1'`);
  assert.deepEqual([plus.kind, plus.owner_role], ['plus', 'product-manager']); assert.match(plus.title, /review on the day/);
  assert.deepEqual([(await startIteration(db, { project_id: 'AG', goal: 'a visitor can book', now: NOW + 7 * DAY })).n], [2]);
  // a predictive project has no iterations; a project not yet executing cannot start one
  await executing(db, 'PR', 'predictive');
  await assert.rejects(startIteration(db, { project_id: 'PR', goal: 'g' }), /milestones, not iterations/);
  await startProject(db, { id: 'EARLY', name: 'e', now: NOW });
  await assert.rejects(startIteration(db, { project_id: 'EARLY', goal: 'g' }), /is in initiating/);
});

test('US-15-R08, T15-6: every deliverable has a closing probe run by a different agent; G3 fails on an unpassed probe, a missing retrospective or an item with no disposition', async () => {
  const db = setup(); await executing(db, 'AG', 'agile');
  await assert.rejects(recordDeliverable(db, { id: 'D1', project_id: 'AG', path_or_ref: 'site/book.js', produced_by: 'doer-1' }), /closing probe a different agent can run/);
  await assert.rejects(recordDeliverable(db, { id: 'D1', project_id: 'AG', path_or_ref: 'site/book.js', produced_by: 'doer-1', closing_probe: 'DELETE FROM items' }), /SELECT/);
  await assert.rejects(recordDeliverable(db, { id: 'D1', project_id: 'AG', path_or_ref: 'chat: I pasted it above', produced_by: 'doer-1', closing_probe: 'SELECT 1 AS value' }), /not chat/);
  await recordDeliverable(db, { id: 'D1', project_id: 'AG', path_or_ref: 'site/book.js', produced_by: 'doer-1', closing_probe: `SELECT v AS value FROM t_vals WHERE k = 'live'`, now: NOW });
  await assert.rejects(runDeliverableProbe(db, 'D1', { runner: 'doer-1', now: NOW }), /different agent/);
  assert.deepEqual(await runDeliverableProbe(db, 'D1', { runner: 'reviewer-1', now: NOW }), { id: 'D1', passed: false, evidence: 'value none' });
  const it = await startIteration(db, { project_id: 'AG', goal: 'g', items: ['AG-W1'], now: NOW }); await endIteration(db, it.id, { demo_result: 'shown', now: NOW });

  assert.equal((await advance(db, 'AG', 'closing', { now: NOW })).ok, true);                  // executing to closing has no gate
  await fill(db, 'AG', 'closing', 'agile');
  const g3 = await advance(db, 'AG', 'closed', { now: NOW });
  assert.equal(g3.ok, false); assert.deepEqual(g3.filed.sort(), ['GATE-AG-closed-deliverable-probes', 'GATE-AG-closed-retrospective']);
  db.raw.exec(`INSERT INTO t_vals VALUES ('live', 1)`);
  assert.equal((await runDeliverableProbe(db, 'D1', { runner: 'reviewer-1', now: NOW })).passed, true);
  await recordRetrospective(db, it.id, { outcome: 'ok', improvements: ['keep demos short'], now: NOW });
  const open = await advance(db, 'AG', 'closed', { now: NOW });                               // T15-6: AG-W1 and the retrospective's plus item have no disposition
  assert.equal(open.ok, false); assert.match(open.gate.reasons[0], /item\(s\) have no disposition/);
  db.raw.exec(`UPDATE items SET status = 'done', disposition = 'done' WHERE project = 'AG' AND id NOT LIKE 'GATE-%'`);
  assert.deepEqual(await advance(db, 'AG', 'closed', { now: NOW }), { ok: true, phase: 'closed' });
});

test('US-15-R10: the status report is four lines with metric values against targets and predicted versus actual, produced on the communication plan\'s period', async () => {
  // The kernel's trigger view reads the wall clock, so this test is placed around the present instead of a fixed date.
  const NOW = Date.now() - 26 * HOUR;
  const db = setup(); await executing(db, 'AG', 'agile', NOW);                               // its communication plan says every 24 h
  await registerMetric(db, { id: 'bookings', program_id: 'AG', op: '>=', target: 10, read_probe: `SELECT v AS value FROM t_vals WHERE k = 'b'` });
  await registerMetric(db, { id: 'errors', program_id: 'AG', kind: 'guard', op: '<=', target: 1, read_probe: `SELECT v AS value FROM t_vals WHERE k = 'e'` });
  db.raw.exec(`INSERT INTO t_vals VALUES ('b', 4), ('e', 0)`);
  await recordDecision(db, { id: 'D-1', program_id: 'AG', decision: 'add a reminder mail', authority: 'product-manager', prediction: 'bookings >= 10 within 24 h', revert_path: 'remove the mail', now: NOW });
  await recordDecision(db, { id: 'D-2', program_id: 'AG', decision: 'shorter form', authority: 'product-manager', prediction: 'bookings >= 5 within 12 h', revert_path: 'restore the form', now: NOW });
  db.raw.exec(`UPDATE t_vals SET v = 12 WHERE k = 'b'`);
  const t1 = NOW + 25 * HOUR;
  await evaluateDecision(db, 'D-1', { now: t1 }); await readMetric(db, 'errors', t1);
  item(db, 'AG-W2', { project: 'AG', status: 'done', disposition: 'done', at: NOW + HOUR }); item(db, 'AG-W3', { project: 'AG', status: 'blocked' });

  assert.deepEqual(await refreshStatusReports(db, { now: NOW + 23 * HOUR }), []);            // not due yet
  const ids = await refreshStatusReports(db, { now: t1 });
  assert.equal(ids.length, 1);
  const r = one(db, `SELECT * FROM lifecycle_status_reports WHERE id = ?`, ids[0]);
  const lines = r.text.split('\n');
  assert.deepEqual(lines.map(l => l.split(':')[0]), ['Happened', 'Decided', 'Next', 'Open']);
  assert.match(lines[0], /1 item\(s\) done/); assert.match(lines[2], /AG-W1/); assert.match(lines[3], /2 item\(s\), 1 blocked/);
  assert.match(lines[3], /bookings=12 \(>= 10: on_target\), errors=0 \(<= 1: on_target\)/);
  assert.deepEqual(JSON.parse(r.variance), [
    { id: 'D-1', predicted: 'bookings >= 10 within 24 h', actual: 12, verdict: 'kept' },
    { id: 'D-2', predicted: 'bookings >= 5 within 12 h', actual: null, verdict: 'late: not scored' }]);
  assert.match(lines[1], /2 decision\(s\) on record, 1 scored; 1 as predicted, 1 not/);
  assert.deepEqual(await refreshStatusReports(db, { now: t1 + HOUR }), []);                  // once per period
  // a stale reading is reported unmeasured, never as its old value
  const later = await produceStatusReport(db, { project_id: 'AG', now: t1 + 3 * DAY });
  assert.equal(later.metrics.find(m => m.id === 'bookings').state, 'unmeasured');
  // the tick produces it with nobody asking
  await setCommunicationPlan(db, 'AG', 1, NOW);
  const tick = await runTick(db, { config, now: t1 + 4 * DAY, extraSteps: [lifecycleStep()] });
  assert.deepEqual(tick.errors, []); assert.match(tick.report, /lifecycle: 1 status report\(s\)/);
});

test('US-15-R12, T15-4: an out-of-scope request creates a scope-gate entry with its answer and no item; nothing is dispatched until a recorded decision enables the pack', async () => {
  const db = setup();
  db.raw.exec(`INSERT INTO roles (id, role, tick_every, model) VALUES ('pm-1', 'project-manager', 1, 'm')`);
  assert.deepEqual(classifyScope('Add a booking form to the home page'), { in_scope: true });
  for (const [text, pack] of [['Write a business plan for the shop', 'business-plan'], ['Please file the trademark for our name', 'legal'], ['I need tax advice on this', 'advice'],
    ['Run our marketing on three channels', 'outreach'], ['Pay the contractor invoice today', 'payments'], ['Write a research paper on the results', 'research']]) assert.equal(classifyScope(text).pack, pack, text);

  const held = await requestWork(db, { id: 'REQ-1', text: 'Write a business plan for the shop', requested_by: 'the-person', now: NOW });
  assert.equal(held.accepted, false); assert.match(held.answer, /outside what Ultrastable does by default.*business-plan pack would cover it/);
  const e = one(db, `SELECT * FROM lifecycle_scope_gate WHERE id = ?`, held.scope_gate_id);
  assert.deepEqual([e.status, e.pack, e.rule, e.item_id, e.requested_by], ['held', 'business-plan', 'business-plan', null, 'the-person']);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM items`).n, 0);
  await runTick(db, { config, now: NOW });
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM dispatches WHERE item_id IS NOT NULL`).n, 0);  // T15-4: no item is dispatched

  const ok = await requestWork(db, { id: 'REQ-2', text: 'Add a booking form to the home page', now: NOW });
  assert.deepEqual(ok, { accepted: true, item_id: 'REQ-2', pack: null });
  assert.equal((await requestWork(db, { id: 'REQ-3', text: 'Draft the newsletter', pack: 'outreach', now: NOW })).accepted, false);   // tagged by an upstream classifier

  await assert.rejects(decidePack(db, { pack: 'business-plan', enabled: true, reason: 'the person asked', decided_by: 'portfolio-manager' }), /revert_path/);
  const d = await decidePack(db, { pack: 'business-plan', enabled: true, reason: 'the person asked', revert_path: 'decidePack enabled=false', decided_by: 'portfolio-manager', now: NOW });
  assert.deepEqual(d.released, [`SCOPED-${held.scope_gate_id}`]);
  assert.deepEqual({ ...one(db, `SELECT status, item_id FROM lifecycle_scope_gate WHERE id = ?`, held.scope_gate_id) }, { status: 'released', item_id: `SCOPED-${held.scope_gate_id}` });
  assert.deepEqual(await requestWork(db, { id: 'REQ-4', text: 'Update the business plan numbers', now: NOW }), { accepted: true, item_id: 'REQ-4', pack: 'business-plan' });
  await decidePack(db, { pack: 'business-plan', enabled: false, reason: 'trial over', revert_path: 'decidePack enabled=true', decided_by: 'portfolio-manager', now: NOW });
  assert.equal((await requestWork(db, { id: 'REQ-5', text: 'Another business plan', now: NOW })).accepted, false);
  assert.deepEqual(rows(db, `SELECT pack FROM lifecycle_scope_gate WHERE status = 'held' ORDER BY id`).map(r => r.pack), ['outreach', 'business-plan']);
});
