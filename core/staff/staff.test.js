// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb } from '../_shared/testdb.js';
import { runTick, STEP_ORDER } from '../src/tick.js';
import { L2_EXTRA_STEPS, MIGRATIONS_DIR as KERNEL_DIR, registerProgram, registerMetric, readMetric } from '../kernel/index.js';
import {
  MIGRATIONS_DIR, registerPersona, setProgramPlane, registerStore, createToolLayer, writeBrief, missingBriefs, isControlPlane,
  queueScore, scoreItem, deleteScore, rankQueue, parseProposal, originate, runManagers, staffStep,
} from './index.js';

const policy = JSON.parse(readFileSync(new URL('../../autonomy/policy.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-10T12:00:00Z'), HOUR = 3600e3;
const ts = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const PM_OPS = ['promote', 'restore', 'close_with_evidence', 'supersede', 'assign_doer', 'originate', 'score'];

function setup() {
  const db = makeDb([KERNEL_DIR, MIGRATIONS_DIR]);
  db.raw.exec(`CREATE TABLE t_vals (k TEXT PRIMARY KEY, v REAL)`);
  return db;
}
const one = (db, sql, ...a) => db.raw.prepare(sql).get(...a);
const rows = (db, sql, ...a) => db.raw.prepare(sql).all(...a);
const item = (db, id, o = {}) => db.raw.prepare(`INSERT INTO items (id, title, kind, owner_role, done_check, priority, status, project, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
  .run(id, o.title || id, o.kind || 'fix', o.owner_role || 'staff', 'x', o.priority ?? 50, o.status || 'ready', o.project ?? null, ts(o.at ?? NOW - 48 * HOUR));
const meta = (db, id, o) => db.raw.prepare(`INSERT INTO kernel_item_meta (item_id, metric_id, doer, critical) VALUES (?,?,?,?)`).run(id, o.metric_id ?? null, o.doer ?? null, o.critical ? 1 : 0);
const focus = (db, program, id, rank = 1, tier = 0) => db.raw.prepare(`INSERT INTO kernel_focus (program_id, item_id, rank, tier, has_doer, tick_id) VALUES (?,?,?,?,0,1)`).run(program, id, rank, tier);
async function staffed(db) {
  await registerProgram(db, { id: 'OPS', name: 'ops' });
  await registerProgram(db, { id: 'REACH', name: 'reach' });
  await registerPersona(db, { id: 'pgm-ops', role: 'program-manager', program_id: 'OPS', scope: 'program OPS', instruction_source: 'agents/roles/product-manager.md', authority: PM_OPS, now: NOW });
  await registerPersona(db, { id: 'pfm', role: 'portfolio-manager', scope: 'all programs', instruction_source: 'agents/roles/portfolio-manager.md', authority: ['allocate', 'demote', 'score'], now: NOW });
  return createToolLayer({ db, now: () => NOW });
}

test('US-02-R05: decision authority is an enumerated list; a role cannot be given an operation above its ceiling', async () => {
  const db = setup();
  const base = { id: 'p', role: 'program-manager', program_id: 'OPS', scope: 's', instruction_source: 'f.md' };
  await assert.rejects(registerPersona(db, { ...base, authority: 'promote' }), /enumerated list/);
  await assert.rejects(registerPersona(db, { ...base, authority: [] }), /enumerated list/);
  await assert.rejects(registerPersona(db, { ...base, authority: ['delete_everything'] }), /unknown operation/);
  await assert.rejects(registerPersona(db, { ...base, authority: ['promote', 'demote'] }), /may not hold: demote/);
  await assert.rejects(registerPersona(db, { ...base, role: 'portfolio-manager', program_id: null, authority: ['close_with_evidence'] }), /may not hold/);
  await assert.rejects(registerPersona(db, { ...base, role: 'archivist', authority: ['allocate'] }), /may not hold/);
  await assert.rejects(registerPersona(db, { ...base, instruction_source: '' }), /instruction_source/);
});

test('US-02-R05: the tool layer applies only operations on the persona list; a refused operation changes nothing and is recorded', async () => {
  const db = setup(); const tools = await staffed(db);
  await registerPersona(db, { id: 'pgm-lite', role: 'program-manager', program_id: 'OPS', scope: 's', instruction_source: 'f.md', authority: ['score'] });
  item(db, 'A', { project: 'OPS', priority: 50 }); focus(db, 'OPS', 'A');
  const r = await tools.act('pgm-lite', 'promote', { item_id: 'A' });
  assert.equal(r.ok, false); assert.equal(r.kind, 'authority');
  assert.equal(one(db, `SELECT priority FROM items WHERE id='A'`).priority, 50);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM staff_actions`).n, 0);
  assert.match(one(db, `SELECT reason FROM staff_denials WHERE persona_id='pgm-lite'`).reason, /not in the decision authority/);
});

test('US-02-R06: an operation is recorded with identifier, item, from, to and evidence, and is reversed by recording the reverse', async () => {
  const db = setup(); const tools = await staffed(db);
  item(db, 'A', { project: 'OPS', priority: 50 }); focus(db, 'OPS', 'A', 2, 0);
  const r = await tools.act('pgm-ops', 'promote', { item_id: 'A' }, { tickId: 7 });
  assert.equal(r.ok, true); assert.equal(r.verified, true);
  const a = one(db, `SELECT * FROM staff_actions WHERE id = ?`, r.action_id);
  assert.deepEqual([a.persona_id, a.op, a.item_id, a.field, a.from_value, a.to_value, a.tick_id], ['pgm-ops', 'promote', 'A', 'priority', '50', '10', 7]);
  assert.match(a.evidence, /focus rank 2/);
  assert.equal(one(db, `SELECT priority FROM items WHERE id='A'`).priority, 10);
  assert.equal((await tools.reverse('pgm-ops', r.action_id, {})).kind, 'precondition'); // a reversal needs evidence
  const rev = await tools.reverse('pgm-ops', r.action_id, { evidence: 'promotion raised risk with no doer' });
  assert.equal(rev.ok, true);
  assert.equal(one(db, `SELECT priority FROM items WHERE id='A'`).priority, 50);
  const b = one(db, `SELECT * FROM staff_actions WHERE id = ?`, rev.action_id);
  assert.deepEqual([b.op, b.from_value, b.to_value, b.reverses], ['reverse:promote', '10', '50', r.action_id]);
  assert.equal(one(db, `SELECT reversed_by FROM staff_actions WHERE id = ?`, r.action_id).reversed_by, rev.action_id);
  assert.equal((await tools.reverse('pgm-ops', r.action_id, { evidence: 'again' })).ok, false); // not twice
  assert.equal((await tools.reverse('pfm', r.action_id, { evidence: 'x' })).kind, 'authority'); // promote is not on the portfolio list
});

test('US-02-R08: a program manager acts in its own program only; a portfolio manager demotes machine-filed criticals across programs and closes nothing', async () => {
  const db = setup(); const tools = await staffed(db);
  item(db, 'R1', { project: 'REACH', priority: 50 }); focus(db, 'REACH', 'R1');
  const other = await tools.act('pgm-ops', 'promote', { item_id: 'R1' });
  assert.equal(other.kind, 'lane'); assert.match(other.reason, /belongs to program REACH/);
  assert.equal(one(db, `SELECT priority FROM items WHERE id='R1'`).priority, 50);

  item(db, 'TICKFAIL-x-1', { project: 'REACH', priority: 0 });                       // machine-filed, critical, 48 h old, no doer
  item(db, 'TICKFAIL-x-2', { project: 'OPS', priority: 0, at: NOW - 2 * HOUR });      // too young
  item(db, 'HAND-1', { project: 'OPS', priority: 0 });                                // filed by hand
  item(db, 'BREACH-m', { project: 'OPS', priority: 0 }); meta(db, 'BREACH-m', { metric_id: 'm', doer: 'staff-1' }); // has a doer
  const d = await tools.act('pfm', 'demote', { item_id: 'TICKFAIL-x-1' });
  assert.equal(d.ok, true); assert.deepEqual([d.from, d.to], [0, 20]);
  assert.match((await tools.act('pfm', 'demote', { item_id: 'TICKFAIL-x-2' })).reason, /older than 24 h/);
  assert.match((await tools.act('pfm', 'demote', { item_id: 'HAND-1' })).reason, /machine-filed/);
  assert.match((await tools.act('pfm', 'demote', { item_id: 'BREACH-m' })).reason, /has a doer/);
  assert.equal((await tools.act('pfm', 'close_with_evidence', { item_id: 'BREACH-m' })).kind, 'authority');
  assert.equal((await tools.act('pgm-ops', 'demote', { item_id: 'HAND-1' })).kind, 'authority');
  // restore: the program manager of the item's program returns the demoted priority
  await registerPersona(db, { id: 'pgm-reach', role: 'program-manager', program_id: 'REACH', scope: 's', instruction_source: 'f.md', authority: PM_OPS });
  const back = await tools.act('pgm-reach', 'restore', { item_id: 'TICKFAIL-x-1' });
  assert.deepEqual([back.ok, back.from, back.to], [true, 20, 0]);
  assert.match((await tools.act('pgm-reach', 'restore', { item_id: 'TICKFAIL-x-1' })).reason, /no demotion to restore/);
});

test('US-03 s4 close with evidence: metric on target, reading fresh, item old enough, no failing remediation contract', async () => {
  const db = setup(); const tools = await staffed(db);
  await registerMetric(db, { id: 'm', program_id: 'OPS', op: '<=', target: 5, max_age_h: 2, read_probe: `SELECT v AS value FROM t_vals WHERE k = 'm'` });
  const mk = (id, o = {}) => { item(db, id, { project: 'OPS', ...o }); meta(db, id, { metric_id: 'm' }); };
  mk('BREACH-m-1'); mk('BREACH-m-young', { at: NOW - 0.5 * HOUR }); mk('BREACH-m-contract'); item(db, 'PLAIN', { project: 'OPS' });
  db.raw.prepare(`INSERT INTO kernel_remediations (item_id, severity, owner, doer, closing_probe, pass_op, pass_value, max_attempts, backoff_h, deadline_h, next_attempt_at, opened_at, status)
    VALUES ('BREACH-m-contract', 3, 'operations', 'd', 'SELECT 1', '>=', 1, 3, '[1]', 24, ?, ?, 'open')`).run(ts(NOW), ts(NOW));
  const close = (id) => tools.act('pgm-ops', 'close_with_evidence', { item_id: id });

  db.raw.exec(`INSERT INTO t_vals VALUES ('m', 9)`); await readMetric(db, 'm', NOW);
  assert.match((await close('BREACH-m-1')).reason, /metric m is breach/);
  db.raw.exec(`UPDATE t_vals SET v = 3`); await readMetric(db, 'm', NOW - 3 * HOUR);
  db.raw.exec(`DELETE FROM kernel_metric_readings WHERE id = 1`);
  assert.match((await close('BREACH-m-1')).reason, /stale/);                      // on target, but read 3 h ago with a 2 h limit
  await readMetric(db, 'm', NOW);
  assert.match((await close('PLAIN')).reason, /trigger-filed/);
  assert.match((await close('BREACH-m-young')).reason, /not old enough/);
  assert.match((await close('BREACH-m-contract')).reason, /remediation contract is open/);
  const ok = await close('BREACH-m-1');
  assert.deepEqual([ok.ok, ok.to], [true, 'done']);
  const it = one(db, `SELECT status, disposition FROM items WHERE id = 'BREACH-m-1'`);
  assert.equal(it.status, 'done'); assert.match(it.disposition, /metric m back on target \(3\)/);
  assert.match(one(db, `SELECT evidence FROM staff_actions WHERE id = ?`, ok.action_id).evidence, /m = 3 on target/);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM staff_denials WHERE kind = 'precondition'`).n, 5);
});

test('US-03 s4 supersede: only the older duplicate, inside the program, with a disposition naming its replacement', async () => {
  const db = setup(); const tools = await staffed(db);
  item(db, 'OLD', { project: 'OPS', title: 'Fix the  Login page!', at: NOW - 72 * HOUR });
  item(db, 'NEW', { project: 'OPS', title: 'fix the login page', at: NOW - 2 * HOUR });
  item(db, 'DIFF', { project: 'OPS', title: 'Something else' });
  item(db, 'FAR', { project: 'REACH', title: 'fix the login page' });
  assert.match((await tools.act('pgm-ops', 'supersede', { item_id: 'DIFF', by: 'NEW' })).reason, /not duplicates/);
  assert.match((await tools.act('pgm-ops', 'supersede', { item_id: 'NEW', by: 'OLD' })).reason, /older duplicate/);
  assert.equal((await tools.act('pgm-ops', 'supersede', { item_id: 'OLD', by: 'FAR' })).kind, 'lane');
  assert.equal((await tools.act('pgm-ops', 'supersede', { item_id: 'OLD', by: 'NEW' })).ok, true);
  assert.deepEqual({ ...one(db, `SELECT status, disposition FROM items WHERE id='OLD'`) }, { status: 'superseded', disposition: 'superseded by NEW' });
});

test('US-02-R10 and assign doer: a control-plane path is refused; the anchor must occur exactly once in the target', async () => {
  const db = setup(); await staffed(db);
  const files = { 'site/page.js': 'const a = 1;\n// ANCHOR-ONE\nconst b = 2;\n// TWICE\n// TWICE\n' };
  const tools = createToolLayer({ db, now: () => NOW, ports: { readFile: async (p) => { if (!(p in files)) throw new Error('not found'); return files[p]; } } });
  item(db, 'A', { project: 'OPS' });
  for (const p of ['core/src/tick.js', 'autonomy/policy.json', '.github/workflows/ci.yml', 'AGENTS.md', 'config/permissions.json', 'docs/governance/rules.md']) {
    assert.equal(isControlPlane(p), true, p);
    assert.equal((await tools.act('pgm-ops', 'assign_doer', { item_id: 'A', doer: 'staff-1', path: p, anchor: 'x' })).kind, 'control_plane', p);
  }
  assert.equal(isControlPlane('site/page.js'), false);
  assert.match((await tools.act('pgm-ops', 'assign_doer', { item_id: 'A', doer: 'staff-1', path: 'site/page.js', anchor: '// TWICE' })).reason, /occurs 2 time/);
  assert.match((await tools.act('pgm-ops', 'assign_doer', { item_id: 'A', doer: 'staff-1', path: 'site/page.js', anchor: 'MISSING' })).reason, /occurs 0 time/);
  assert.match((await tools.act('pgm-ops', 'assign_doer', { item_id: 'A', doer: 'staff-1', path: 'site/none.js', anchor: 'x' })).reason, /cannot read/);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM kernel_item_meta WHERE item_id = 'A'`).n, 0);
  const ok = await tools.act('pgm-ops', 'assign_doer', { item_id: 'A', doer: 'staff-1', path: 'site/page.js', anchor: '// ANCHOR-ONE' });
  assert.deepEqual([ok.ok, ok.from, ok.to], [true, null, 'staff-1']);
  assert.equal(one(db, `SELECT doer FROM kernel_item_meta WHERE item_id = 'A'`).doer, 'staff-1');
});

test('US-02-T03, US-02-R09: a private-plane persona is denied organization-plane rows by the tool layer, from its identity', async () => {
  const db = setup(); const tools = await staffed(db);
  await registerProgram(db, { id: 'PRIVATE', name: 'private' });
  await registerPersona(db, { id: 'pgm-private', role: 'program-manager', plane: 'private', program_id: 'PRIVATE', scope: 'private plane', instruction_source: 'f.md', authority: PM_OPS });
  item(db, 'ORG-1', { project: 'OPS', title: 'organization secret roadmap' });
  item(db, 'NOPROJ', { title: 'organization item with no program' });
  item(db, 'PRV-1', { project: 'PRIVATE', title: 'private roadmap' });
  await registerStore(db, 'kernel_decisions', 'org');
  await registerStore(db, 'staff_briefs', 'private');

  const q = await tools.items('pgm-private', { plane: 'org', text: 'roadmap' });
  assert.equal(q.denied, true); assert.deepEqual(q.rows, []);
  assert.equal((await tools.items('pgm-private', { program_id: 'OPS' })).denied, true);
  // naming no plane never widens the read: only the requester's own plane comes back
  assert.deepEqual((await tools.items('pgm-private', { text: 'roadmap' })).rows.map(r => r.id), ['PRV-1']);
  assert.deepEqual((await tools.items('pgm-ops', {})).rows.map(r => r.id).sort(), ['NOPROJ', 'ORG-1']);
  assert.equal((await tools.items('pgm-ops', { plane: 'private' })).denied, true);
  assert.equal((await tools.readStore('pgm-private', 'kernel_decisions')).denied, true);
  assert.equal((await tools.readStore('pgm-private', 'items')).denied, true);          // unregistered store: refused, not guessed
  assert.equal((await tools.readStore('pgm-private', 'staff_briefs')).ok, true);
  // writes and origination stay in the plane too
  assert.equal((await tools.act('pgm-private', 'assign_doer', { item_id: 'ORG-1', doer: 'x' })).kind, 'lane');
  const research = async () => 'TITLE: t\nWHY: w\ncode-task: site/a.js\ncode-anchor: x\nEDIT: e';
  const t2 = createToolLayer({ db, now: () => NOW, ports: { research } });
  assert.equal((await originate(t2, 'pgm-private', { program_id: 'OPS' })).kind, 'lane');
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM items WHERE id LIKE 'ROADMAP-%'`).n, 0);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM staff_denials WHERE persona_id = 'pgm-private' AND kind = 'lane'`).n, 6);
  // a program moved to another plane leaves its old manager outside
  await setProgramPlane(db, 'OPS', 'private');
  assert.equal((await tools.act('pgm-ops', 'assign_doer', { item_id: 'ORG-1', doer: 'x' })).kind, 'lane');
});

test('US-02-R07: a persona writes exactly one brief per tick it runs, built from its rows of that tick', async () => {
  const db = setup(); const tools = await staffed(db);
  item(db, 'A', { project: 'OPS', priority: 50 }); focus(db, 'OPS', 'A', 1, 0);
  item(db, 'TICKFAIL-s-1', { project: 'OPS', priority: 0 });
  await tools.act('pgm-ops', 'demote', { item_id: 'A' }, { tickId: 4 });               // refused: recorded for the brief
  assert.deepEqual(await missingBriefs(db, 4), ['pgm-ops']);
  const r = await runManagers(db, { tickId: 4, now: NOW });
  assert.deepEqual([r.personas, r.briefs, r.errors.length], [2, 2, 0]);
  await runManagers(db, { tickId: 4, now: NOW });                                     // a repeat keeps one row per persona
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM staff_briefs WHERE tick_id = 4`).n, 2);
  assert.deepEqual(await missingBriefs(db, 4), []);
  const b = one(db, `SELECT * FROM staff_briefs WHERE persona_id = 'pgm-ops'`);
  assert.match(b.text, /promote A priority 50 -> 10/); assert.match(b.text, /Refused: demote A: demote is not in the decision authority/);
  assert.match(one(db, `SELECT text FROM staff_briefs WHERE persona_id = 'pfm'`).text, /demote TICKFAIL-s-1 priority 0 -> 20/);
  // tick_every: a persona not due on a tick does not run and writes no brief
  await registerPersona(db, { id: 'pgm-slow', role: 'program-manager', program_id: 'REACH', scope: 's', instruction_source: 'f.md', authority: PM_OPS, tick_every: 2 });
  await runManagers(db, { tickId: 5, now: NOW });
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM staff_briefs WHERE persona_id = 'pgm-slow'`).n, 0);
  await runManagers(db, { tickId: 6, now: NOW });
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM staff_briefs WHERE persona_id = 'pgm-slow' AND tick_id = 6`).n, 1);
  assert.match(await writeBrief(db, 'pgm-slow', 6, NOW), /nothing needed doing/);
});

test('US-02-R11: a role filled by a person gets the same action record, prediction, brief and trust outcome, and is never acted for', async () => {
  const db = setup(); const tools = await staffed(db);
  await registerMetric(db, { id: 'reach_visits', program_id: 'REACH', op: '>=', target: 10, read_probe: `SELECT 12 AS value` });
  await registerPersona(db, { id: 'pgm-reach', role: 'program-manager', program_id: 'REACH', scope: 'program REACH', instruction_source: 'agents/roles/product-manager.md', authority: PM_OPS, filled_by: 'person', holder: 'a-person' });
  item(db, 'R1', { project: 'REACH', priority: 50 }); focus(db, 'REACH', 'R1', 1, 0);
  item(db, 'R2', { project: 'REACH', priority: 50 }); focus(db, 'REACH', 'R2', 2, 0);
  assert.match((await tools.act('pgm-reach', 'promote', { item_id: 'R1', prediction: 'visits will go up' }, { tickId: 9 })).reason, /not parsable/);
  const r = await tools.act('pgm-reach', 'promote', { item_id: 'R1', prediction: 'reach_visits >= 10 within 24 h' }, { tickId: 9 });
  assert.equal(r.ok, true);
  const d = one(db, `SELECT * FROM kernel_decisions WHERE id = ?`, r.decision_id);
  assert.match(d.authority, /pgm-reach \(program-manager\): promote/); assert.equal(d.revert_path, `reverse staff action ${r.action_id}`);
  const o = one(db, `SELECT * FROM outcomes WHERE agent = 'pgm-reach'`);
  assert.deepEqual([o.surface, o.action_class, o.result, o.item_id], ['manager-ops', 'promote', 'verified', 'R1']);
  await runManagers(db, { tickId: 9, now: NOW });
  assert.equal(one(db, `SELECT priority FROM items WHERE id = 'R2'`).priority, 50);   // the tick did not promote for the person
  assert.match(one(db, `SELECT text FROM staff_briefs WHERE persona_id = 'pgm-reach' AND tick_id = 9`).text, /filled by a person[\s\S]*promote R1/);
  await runManagers(db, { tickId: 10, now: NOW });                                    // the person did nothing on tick 10: no brief
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM staff_briefs WHERE persona_id = 'pgm-reach' AND tick_id = 10`).n, 0);
});

test('US-03 s4 queue score: the two worked examples, and factor validation', () => {
  assert.equal(queueScore({ impact: 5, probability: 5, capability_gain: 5, reach_gain: 5, remediation_cost: 1, trust: 0.47, direction: 0 }), 117.5);
  assert.ok(Math.abs(queueScore({ impact: 4, probability: 3, capability_gain: 4, reach_gain: 1, remediation_cost: 2, trust: 0.5, direction: 0.2 }) - 18) < 1e-9);
  assert.throws(() => queueScore({ impact: 6, probability: 3, capability_gain: 4, reach_gain: 1, remediation_cost: 2, trust: 0.5, direction: 0 }), /impact/);
  assert.throws(() => queueScore({ impact: 4, probability: 3, capability_gain: 4, reach_gain: 1, remediation_cost: 0, trust: 0.5, direction: 0 }), /remediation_cost/);
  assert.throws(() => queueScore({ impact: 4, probability: 3, capability_gain: 4, reach_gain: 1, remediation_cost: 1, trust: 1.5, direction: 0 }), /trust/);
});

test('US-01-R07: priority score rows carry their writer; a persona replaces and deletes only its own rows', async () => {
  const db = setup(); const tools = await staffed(db);
  item(db, 'F', { project: 'OPS' }); focus(db, 'OPS', 'F');
  item(db, 'H', { project: 'OPS', priority: 8 }); item(db, 'U', { project: 'OPS' });
  db.raw.prepare(`UPDATE items SET surface = 'repo', action_class = 'edit' WHERE id = 'F'`).run();
  db.raw.prepare(`INSERT INTO trust_ledger (surface, action_class, rung, reliability, outcomes) VALUES ('repo', 'edit', 'observed', 0.47, 9)`).run();
  const f = await scoreItem(tools, 'pgm-ops', 'F');                                   // focus item: full factors, trust from the ledger
  assert.equal(f.score, 117.5);
  const h = await scoreItem(tools, 'pgm-ops', 'H', { impact: 4, probability: 3, capability_gain: 4, reach_gain: 1, remediation_cost: 2, direction: 0.2 });
  assert.ok(Math.abs(h.score - 18) < 1e-9);                                            // default trust 0.5
  assert.match((await scoreItem(tools, 'pgm-ops', 'U')).reason, /impact/);            // an unfocused item needs an assessment
  await scoreItem(tools, 'pfm', 'H', { impact: 1, probability: 1, capability_gain: 1, reach_gain: 0, remediation_cost: 1 });
  assert.deepEqual(rows(db, `SELECT writer FROM staff_priority_scores WHERE item_id = 'H' ORDER BY writer`).map(r => r.writer), ['pfm', 'pgm-ops']);
  assert.deepEqual((await rankQueue(db, { program_id: 'OPS' })).map(r => r.item_id), ['F', 'H']);
  const denied = await deleteScore(tools, 'pfm', 'H', { writer: 'pgm-ops' });
  assert.equal(denied.kind, 'lane');
  assert.equal((await deleteScore(tools, 'pfm', 'H')).deleted, 1);
  assert.deepEqual(rows(db, `SELECT writer FROM staff_priority_scores WHERE item_id = 'H'`).map(r => r.writer), ['pgm-ops']);
  item(db, 'R', { project: 'REACH' });
  assert.equal((await scoreItem(tools, 'pgm-ops', 'R', { impact: 1, probability: 1, capability_gain: 1, reach_gain: 1, remediation_cost: 1 })).kind, 'lane');
});

test('US-03 s4 origination: fewer than 3 open roadmap items, once a day per program, five fields, control-plane refused, daily cap', async () => {
  const db = setup(); await staffed(db);
  assert.deepEqual(parseProposal('TITLE: Add a today summary\nWHY: usage is flat\nand people ask\ncode-task: site/home.js\ncode-anchor: // SUMMARY\nEDIT: render the summary').fields,
    { title: 'Add a today summary', why: 'usage is flat\nand people ask', code_task: 'site/home.js', code_anchor: '// SUMMARY', edit: 'render the summary' });
  assert.deepEqual(parseProposal('TITLE: x\nWHY: y').missing, ['code_task', 'code_anchor', 'edit']);
  let asked = 0, reply = 'TITLE: Add a today summary\nWHY: usage is flat\ncode-task: site/home.js\ncode-anchor: // SUMMARY\nEDIT: render the summary';
  const ports = { research: async () => { asked++; return reply; }, readFile: async () => 'x\n// SUMMARY\ny' };
  let now = NOW; const tools = createToolLayer({ db, now: () => now, ports });
  const r = await originate(tools, 'pgm-ops', { tickId: 3 });
  assert.equal(r.filed, 'ROADMAP-OPS-20261110');
  const it = one(db, `SELECT * FROM items WHERE id = ?`, r.filed);
  assert.deepEqual([it.title, it.kind, it.project, it.owner_role, it.status], ['Add a today summary', 'work', 'OPS', 'staff', 'ready']);
  assert.equal(one(db, `SELECT doer FROM kernel_item_meta WHERE item_id = ?`, r.filed).doer, 'code-task:site/home.js');
  assert.equal(one(db, `SELECT op FROM staff_actions WHERE item_id = ?`, r.filed).op, 'originate');
  assert.deepEqual(await originate(tools, 'pgm-ops'), { skipped: 'already asked today' });
  assert.equal(asked, 1);
  assert.equal((await originate(tools, 'pfm')).kind, 'authority');

  now = NOW + 24 * HOUR; reply = reply.replace('site/home.js', 'autonomy/policy.json');   // next day: a control-plane target
  assert.match((await originate(tools, 'pgm-ops')).refused, /control-plane/);
  now = NOW + 48 * HOUR; reply = 'TITLE: only a title';
  assert.match((await originate(tools, 'pgm-ops')).refused, /lacks: WHY, code-task, code-anchor, EDIT/);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM items WHERE id LIKE 'ROADMAP-%'`).n, 1);
  now = NOW + 72 * HOUR; item(db, 'W1', { project: 'OPS', kind: 'work' }); item(db, 'W2', { project: 'OPS', kind: 'plus' });
  assert.deepEqual(await originate(tools, 'pgm-ops'), { skipped: '3 open roadmap item(s)' });

  // daily cap across programs (default 4): the fifth program of the day is not asked
  now = NOW + 96 * HOUR; reply = 'TITLE: t\nWHY: w\ncode-task: site/home.js\ncode-anchor: // SUMMARY\nEDIT: e';
  for (const p of ['P1', 'P2', 'P3', 'P4', 'P5']) {
    await registerProgram(db, { id: p, name: p });
    await registerPersona(db, { id: `pgm-${p}`, role: 'program-manager', program_id: p, scope: 's', instruction_source: 'f.md', authority: ['originate'] });
  }
  const got = []; for (const p of ['P1', 'P2', 'P3', 'P4', 'P5']) got.push(await originate(tools, `pgm-${p}`));
  assert.deepEqual(got.map(g => Boolean(g.filed)), [true, true, true, true, false]);
  assert.match(got[4].skipped, /daily cap of 4/);
  assert.deepEqual(await originate(createToolLayer({ db, now: () => now }), 'pgm-P5'), { skipped: 'no research agent is configured' });
});

test('the managers run as a tick step after the kernel L2 step: allocation is logged, focus is promoted and scored, duplicates and recovered triggers close', async () => {
  const db = setup(); await staffed(db);
  await registerProgram(db, { id: 'OPS', name: 'ops', primary_metric_id: 'ops_errors' });
  await registerMetric(db, { id: 'ops_errors', program_id: 'OPS', op: '<=', target: 5, read_probe: `SELECT v AS value FROM t_vals WHERE k = 'e'` });
  db.raw.exec(`INSERT INTO t_vals VALUES ('e', 2)`);
  const t0 = Date.now();
  const mk = (id, o = {}) => item(db, id, { project: 'OPS', owner_role: 'nobody', at: t0 - 48 * HOUR, ...o });
  mk('BREACH-ops_errors', { priority: 40 }); meta(db, 'BREACH-ops_errors', { metric_id: 'ops_errors' });
  mk('DUP-old', { title: 'Tidy the queue', at: t0 - 72 * HOUR }); mk('DUP-new', { title: 'tidy the queue' });
  const config = { org_slug: 't', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy, kernel: { slots: 4 } };
  const r = await runTick(db, { config, now: t0, extraSteps: [...L2_EXTRA_STEPS, staffStep()] });
  assert.equal(r.total, STEP_ORDER.length + 2); assert.deepEqual(r.errors, []); assert.match(r.report, /staff: 2 persona\(s\), 2 brief\(s\)/);
  assert.equal(one(db, `SELECT status FROM items WHERE id = 'BREACH-ops_errors'`).status, 'done');   // its metric is back on target
  assert.equal(one(db, `SELECT disposition FROM items WHERE id = 'DUP-old'`).disposition, 'superseded by DUP-new');
  const alloc = one(db, `SELECT * FROM staff_actions WHERE op = 'allocate'`);
  assert.equal(alloc.persona_id, 'pfm'); assert.match(alloc.to_value, /OPS=4/); assert.equal(alloc.evidence, `decision ALLOC-${r.tickId}`);
  assert.ok(one(db, `SELECT score FROM staff_priority_scores WHERE item_id = 'DUP-new' AND writer = 'pgm-ops'`).score > 0);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM staff_briefs WHERE tick_id = ?`, r.tickId).n, 2);
  // the switch that stops manager operations stops the staff step too (US-03-R14)
  const off = await runTick(db, { config: { ...config, kernel: { slots: 4, manager_ops: false } }, now: t0 + HOUR, extraSteps: [...L2_EXTRA_STEPS, staffStep()] });
  assert.match(off.report, /staff: manager operations off/);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM staff_briefs WHERE tick_id = ?`, off.tickId).n, 0);
});

test('US-02-T01, US-02-T02: dispatch goes by owner_role, and a new role row is dispatched with no code change', async () => {
  const db = setup();
  const config = { org_slug: 't', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy };
  db.raw.exec(`INSERT INTO roles (id, role, tick_every, model) VALUES ('staff-1', 'staff', 1, 'm-a')`);
  item(db, 'PF-1', { owner_role: 'portfolio-manager' });
  await runTick(db, { config, now: NOW });
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM claims WHERE item_id = 'PF-1'`).n, 0);              // T01: staff did not claim it
  db.raw.exec(`INSERT INTO roles (id, role, tick_every, model) VALUES ('archivist-1', 'archivist', 1, 'm-b')`);
  item(db, 'AR-1', { owner_role: 'archivist' });
  await runTick(db, { config, now: NOW + HOUR });
  assert.equal(one(db, `SELECT role_id FROM dispatches WHERE item_id = 'AR-1'`).role_id, 'archivist-1'); // T02
});
