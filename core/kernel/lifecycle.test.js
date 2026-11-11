// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { kdb, item, one, rows } from './testkit.js';
import {
  CATALOG, createProject, submitArtifact, reviewArtifact, recordReadback, checkGate, advancePhase, amendArtifact, decideChangeRequest,
  addRisk, addLesson, lifecycleGaps,
} from './lifecycle.js';

async function project(db, id = 'p1', mode = 'hybrid') {
  await createProject(db, { id, name: 'Demo', delivery_mode: mode, mode_reason: 'requirements partly unclear' });
}
async function produce(db, id, kind, o = {}) {
  await submitArtifact(db, { project_id: id, kind, path_or_ref: `records/${kind}.md`, produced_by: 'doer-1', produced_model: 'alpha-1', done_check: 'probe', done_check_passed: true, ...o });
}
async function produceAndReview(db, id, phase) {
  for (const c of CATALOG.filter(x => x.phase === phase)) {
    await produce(db, id, c.kind);
    await reviewArtifact(db, { project_id: id, kind: c.kind, reviewer: 'reviewer-1', reviewer_model: 'beta-2', verdict: 'approved' });
  }
}
async function throughG1(db, id = 'p1') { await produceAndReview(db, id, 'initiating'); return advancePhase(db, id, 'planning'); }
async function throughG2(db, id = 'p1') {
  await produceAndReview(db, id, 'planning'); await recordReadback(db, id); item(db, 'W1', { project: id });
  return advancePhase(db, id, 'executing');
}

test('the five lifecycle tables exist with their normative names and minimum columns (US-15 s8)', () => {
  const db = kdb();
  const need = {
    phases: ['project_id', 'phase', 'entered_at', 'gate_id', 'gate_passed_at'],
    artifacts: ['id', 'project_id', 'phase', 'kind', 'path_or_ref', 'owner_role', 'reviewed_by', 'status'],
    change_requests: ['id', 'project_id', 'summary', 'effect', 'decision', 'decided_by', 'decided_at', 'revert_path'],
    risks: ['id', 'project_id', 'cause', 'effect', 'likelihood', 'impact', 'response', 'owner_role', 'trigger', 'status'],
    lessons: ['id', 'project_id', 'text', 'plus_item_id'],
  };
  for (const [t, cols] of Object.entries(need)) {
    const have = rows(db, `PRAGMA table_info(${t})`).map(c => c.name);
    for (const c of cols) assert.ok(have.includes(c), `${t}.${c}`);
  }
});

test('US-15-R01: delivery mode needs a recorded reason', async () => {
  const db = kdb();
  await assert.rejects(createProject(db, { id: 'x', name: 'x', delivery_mode: 'agile', mode_reason: ' ' }), /reason/);
  await assert.rejects(createProject(db, { id: 'x', name: 'x', delivery_mode: 'chaos', mode_reason: 'r' }), /delivery_mode/);
});

test('US-15-T1: a project cannot reach Planning or Executing with artifacts missing; the attempt creates items, not an error', async () => {
  const db = kdb(); await project(db);
  const r = await advancePhase(db, 'p1', 'planning');
  assert.equal(r.ok, false); assert.equal(r.gate.missing.length, 6);
  assert.equal(r.filed.length, 6);
  assert.equal(one(db, `SELECT owner_role FROM items WHERE id='GATE-p1-A-INI-1'`).owner_role, 'portfolio-manager');
  assert.equal(one(db, `SELECT current_phase FROM kernel_projects`).current_phase, 'initiating');
  assert.equal((await advancePhase(db, 'p1', 'planning')).filed.length, 0, 'filing is idempotent');
  await assert.rejects(advancePhase(db, 'p1', 'executing'), /cannot move/);

  assert.equal((await throughG1(db)).ok, true);
  assert.ok(one(db, `SELECT gate_passed_at FROM phases WHERE phase='initiating'`).gate_passed_at);
  const g2 = await advancePhase(db, 'p1', 'executing');
  assert.equal(g2.ok, false); assert.equal(g2.gate.missing.length, 10);
  assert.ok(g2.filed.includes('GATE-p1-A-PLN-7'));
});

test('a phase gate refuses to pass without reviewed artifacts (conformance)', async () => {
  const db = kdb(); await project(db);
  for (const c of CATALOG.filter(x => x.phase === 'initiating')) await produce(db, 'p1', c.kind);
  const g = await checkGate(db, 'p1', 'G1');
  assert.equal(g.pass, false); assert.equal(g.unreviewed.length, 6); assert.equal(g.missing.length, 0);
  const r = await advancePhase(db, 'p1', 'planning');
  assert.equal(r.ok, false); assert.ok(r.filed.includes('GATE-p1-A-INI-1-review'));
  assert.equal(one(db, `SELECT owner_role FROM items WHERE id='GATE-p1-A-INI-1-review'`).owner_role, 'reviewer');
});

test('phase theater: an artifact that fails its done check, is chat, or is empty does not satisfy the gate', async () => {
  const db = kdb(); await project(db);
  await assert.rejects(produce(db, 'p1', 'A-INI-1', { path_or_ref: 'chat: see above' }), /not chat/);
  await assert.rejects(produce(db, 'p1', 'A-INI-1', { path_or_ref: '' }), /not chat|file or record/);
  await produceAndReview(db, 'p1', 'initiating');
  await produce(db, 'p1', 'A-INI-2', { done_check_passed: false });
  await reviewArtifact(db, { project_id: 'p1', kind: 'A-INI-2', reviewer: 'reviewer-1', reviewer_model: 'beta-2', verdict: 'approved' });
  const g = await checkGate(db, 'p1', 'G1');
  assert.deepEqual(g.failing, ['A-INI-2']); assert.equal(g.pass, false);
});

test('US-15-T2: a reviewer equal to the doer, or from the same model family, is rejected', async () => {
  const db = kdb(); await project(db);
  await produce(db, 'p1', 'A-INI-1');
  await assert.rejects(reviewArtifact(db, { project_id: 'p1', kind: 'A-INI-1', reviewer: 'doer-1', verdict: 'approved' }), /differ from doer/);
  await assert.rejects(reviewArtifact(db, { project_id: 'p1', kind: 'A-INI-1', reviewer: 'reviewer-1', reviewer_model: 'alpha-9', verdict: 'approved' }), /model family/);
  await reviewArtifact(db, { project_id: 'p1', kind: 'A-INI-1', reviewer: 'reviewer-1', reviewer_model: 'beta-2', verdict: 'approved' });
  assert.equal(one(db, `SELECT reviewed_by FROM artifacts`).reviewed_by, 'reviewer-1');
  // a tampered record where reviewer = doer is still refused by the gate
  await produceAndReview(db, 'p1', 'initiating');
  db.raw.exec(`UPDATE artifacts SET reviewed_by = produced_by WHERE kind = 'A-INI-3'`);
  assert.deepEqual((await checkGate(db, 'p1', 'G1')).unreviewed, ['A-INI-3']);
});

test('G2 also needs the read-back, work items, and a closing probe on every item', async () => {
  const db = kdb(); await project(db); await throughG1(db);
  await produceAndReview(db, 'p1', 'planning');
  let g = await checkGate(db, 'p1', 'G2');
  assert.equal(g.pass, false); assert.equal(g.reasons.length, 2);
  await advancePhase(db, 'p1', 'executing'); // files gap items; they must not satisfy the checks themselves
  assert.equal((await checkGate(db, 'p1', 'G2')).reasons.length, 2);
  await recordReadback(db, 'p1'); item(db, 'W1', { project: 'p1', closing_probe: null });
  assert.match((await checkGate(db, 'p1', 'G2')).reasons.join(), /no closing probe/);
  db.raw.exec(`UPDATE items SET closing_probe = 'p' WHERE id = 'W1'`);
  assert.equal((await checkGate(db, 'p1', 'G2')).pass, true);
});

test('US-15-T3: a change to the charter after G1 is a change request with a revert path; it is not applied until decided', async () => {
  const db = kdb(); await project(db); await throughG1(db);
  await assert.rejects(produce(db, 'p1', 'A-INI-2'), /amendArtifact|gate already passed/);
  await assert.rejects(amendArtifact(db, { project_id: 'p1', kind: 'A-INI-2', new_ref: 'records/charter-v2.md', summary: 'raise cap', requested_by: 'pm' }), /revert path/);
  const r = await amendArtifact(db, { project_id: 'p1', kind: 'A-INI-2', new_ref: 'records/charter-v2.md', summary: 'raise cap', effect: 'cost +10%', revert_path: 'restore records/A-INI-2.md', requested_by: 'pm' });
  assert.equal(r.applied, false);
  const cr = one(db, `SELECT * FROM change_requests WHERE id = ?`, r.change_request_id);
  assert.equal(cr.revert_path, 'restore records/A-INI-2.md'); assert.equal(cr.decision, null);
  assert.equal(one(db, `SELECT path_or_ref FROM artifacts WHERE kind='A-INI-2'`).path_or_ref, 'records/A-INI-2.md');
  await assert.rejects(decideChangeRequest(db, r.change_request_id, { decision: 'approved', decided_by: 'pm' }), /differ/);
  await decideChangeRequest(db, r.change_request_id, { decision: 'approved', decided_by: 'portfolio-manager' });
  const cr2 = one(db, `SELECT * FROM change_requests`);
  assert.equal(cr2.decision, 'approved'); assert.equal(cr2.decided_by, 'portfolio-manager'); assert.ok(cr2.decided_at);
  const a = one(db, `SELECT * FROM artifacts WHERE kind='A-INI-2'`);
  assert.equal(a.path_or_ref, 'records/charter-v2.md'); assert.equal(a.status, 'submitted'); assert.equal(a.reviewed_by, null, 'the changed artifact needs a fresh review');
});

test('before its gate an artifact may be edited directly', async () => {
  const db = kdb(); await project(db); await produce(db, 'p1', 'A-INI-2');
  assert.equal((await amendArtifact(db, { project_id: 'p1', kind: 'A-INI-2', new_ref: 'records/v2.md' })).applied, true);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM change_requests`).n, 0);
});

test('US-15-T6: closing with an item that has no disposition fails G3; with dispositions it passes', async () => {
  const db = kdb(); await project(db); await throughG1(db); await throughG2(db);
  assert.equal((await advancePhase(db, 'p1', 'closing')).ok, true);
  item(db, 'W2', { project: 'p1' }); db.raw.exec(`UPDATE items SET disposition = 'delivered: probe ok' WHERE id = 'W1'`);
  await produceAndReview(db, 'p1', 'closing');
  const g = await checkGate(db, 'p1', 'G3');
  assert.equal(g.pass, false); assert.match(g.reasons.join(), /no disposition/);
  const r = await advancePhase(db, 'p1', 'closed');
  assert.equal(r.ok, false); assert.ok(r.filed.some(f => f.includes('G3')));
  db.raw.exec(`UPDATE items SET disposition = 'moved to backlog with trigger' WHERE id = 'W2'`);
  assert.equal((await advancePhase(db, 'p1', 'closed')).ok, true);
  assert.equal(one(db, `SELECT current_phase FROM kernel_projects`).current_phase, 'closed');
});

test('risks and lessons: each lesson is filed into the plus queue (A-CLO-3)', async () => {
  const db = kdb(); await project(db);
  const rid = await addRisk(db, { project_id: 'p1', cause: 'vendor delay', effect: 'schedule slip', likelihood: 3, impact: 4, owner_role: 'project-manager', trigger: 'no delivery by day 10' });
  assert.equal(one(db, `SELECT status FROM risks WHERE id = ?`, rid).status, 'open');
  const l = await addLesson(db, { project_id: 'p1', text: 'write the probe first' });
  const it = one(db, `SELECT * FROM items WHERE id = ?`, l.plus_item_id);
  assert.equal(it.kind, 'plus'); assert.equal(one(db, `SELECT plus_item_id FROM lessons`).plus_item_id, l.plus_item_id);
});

test('the tick activity files missing gate artifacts for every project (US-15 s7)', async () => {
  const db = kdb(); await project(db, 'a'); await project(db, 'b', 'agile');
  assert.equal((await lifecycleGaps(db)).length, 12);
  assert.equal((await lifecycleGaps(db)).length, 0);
});
