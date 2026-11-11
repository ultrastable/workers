// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb } from '../_shared/testdb.js';
import { runTick, STEP_ORDER } from '../src/tick.js';
import * as K from './index.js';

const policy = JSON.parse(readFileSync(new URL('../../autonomy/policy.json', import.meta.url), 'utf8'));
const config = (kernel = {}) => ({ org_slug: 't', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy, kernel });
const mk = () => makeDb([K.MIGRATIONS_DIR]);
const H = 3600e3;
const items = (db, where = '1=1') => db.raw.prepare(`SELECT * FROM items WHERE ${where}`).all();

async function setup(db) {
  db.raw.exec(`CREATE TABLE sig (k TEXT PRIMARY KEY, v REAL);`);
  const set = (k, v) => db.raw.prepare('INSERT OR REPLACE INTO sig VALUES (?,?)').run(k, v);
  await K.registerMetric(db, { id: 'usage', program_id: 'p1', kind: 'target', op: '>=', target: 100, read_probe: `SELECT v AS value FROM sig WHERE k='usage'` });
  await K.registerMetric(db, { id: 'errors', program_id: 'p1', kind: 'guard', op: '<=', target: 1, read_probe: `SELECT v AS value FROM sig WHERE k='errors'` });
  return set;
}

test('metric trigger state is computed by a view; stale or failing reads are unmeasured, never a pass', async () => {
  const db = mk(); const set = await setup(db);
  set('usage', 120); set('errors', 5);
  await K.readAllMetrics(db);
  const st = Object.fromEntries((await K.triggerStates(db)).map(r => [r.id, r]));
  assert.equal(st.usage.state, 'on_target'); assert.equal(st.usage.hit, 0);
  assert.equal(st.errors.state, 'breach'); assert.equal(st.errors.hit, 1);
  assert.equal(await K.metricsInBreach(db), 1);
  db.raw.exec(`UPDATE kernel_metric_readings SET read_at = '2000-01-01 00:00:00'`);
  assert.equal((await K.triggerStates(db)).every(r => r.state === 'unmeasured'), true);
  db.raw.exec('DROP TABLE sig');
  const r = await K.readMetric(db, 'usage');
  assert.equal(r.value, null); assert.match(r.evidence, /probe error/);
  await assert.rejects(() => K.registerMetric(db, { id: 'x', op: '>=', target: 1, read_probe: 'DELETE FROM items' }), /SELECT/);
});

test('decision needs prediction, authority and revert path; predictions parse (US-05-T03)', async () => {
  const db = mk(); await setup(db);
  assert.deepEqual(K.parsePrediction('queue_depth <= 5 within 24 h'), { form: 'metric', metric: 'queue_depth', op: '<=', value: 5, hours: 24 });
  assert.equal(K.parsePrediction('queue_depth soon'), null);
  assert.equal(K.parsePrediction('issue X-1 closed within 6 h').form, 'issue');
  const base = { id: 'D1', decision: 'ship', authority: 'plus loop', prediction: 'usage >= 110 within 24 h', program_id: 'p1' };
  await assert.rejects(() => K.recordDecision(db, base), /revert_path/);
  await assert.rejects(() => K.recordDecision(db, { ...base, revert_path: 'r', prediction: 'nonsense' }), /parsable/);
  await K.recordDecision(db, { ...base, revert_path: 'git revert abc', now: Date.now() - 24 * H });
  const row = db.raw.prepare('SELECT * FROM kernel_decisions').get();
  assert.equal(row.op, '>='); assert.equal(row.target, 110); assert.equal(row.revert_path, 'git revert abc');
  assert.ok(row.due_at < new Date().toISOString().replace('T', ' ').slice(0, 19) || true);
});

test('a breached guard blocks a target gain from being kept (US-05, US-04-R08)', async () => {
  const db = mk(); const set = await setup(db);
  set('usage', 100); set('errors', 0.5);
  await K.recordDecision(db, { id: 'D1', decision: 'add summary', authority: 'plus', prediction: 'usage >= 110 within 1 h', revert_path: 'revert PR 9', program_id: 'p1', now: Date.now() - 2 * H });
  set('usage', 140); set('errors', 3); // gain, but the guard is breached
  const r = await K.evaluateDecision(db, 'D1');
  assert.equal(r.status, 'reverted'); assert.match(r.outcome, /blocked_by_guard: errors/);
  assert.equal(items(db, "id='REVERT-D1'").length, 1);
});

test('a gain with the guard intact is kept; a worsened guard inside target still blocks; unmeasured is not a pass', async () => {
  const db = mk(); const set = await setup(db);
  set('usage', 100); set('errors', 0.2);
  await K.recordDecision(db, { id: 'K1', decision: 'a', authority: 'x', prediction: 'usage >= 110 within 1 h', revert_path: 'r', program_id: 'p1', now: Date.now() - 2 * H });
  set('usage', 137); set('errors', 0.2);
  assert.equal((await K.evaluateDecision(db, 'K1')).status, 'kept');
  await K.recordDecision(db, { id: 'K2', decision: 'b', authority: 'x', prediction: 'usage >= 110 within 1 h', revert_path: 'r', program_id: 'p1', now: Date.now() - 2 * H });
  set('errors', 0.9); // still under target 1 but worse than baseline 0.2
  assert.equal((await K.evaluateDecision(db, 'K2')).status, 'reverted');
  await K.recordDecision(db, { id: 'K3', decision: 'c', authority: 'x', prediction: 'usage >= 110 within 1 h', revert_path: 'r', program_id: 'p1', now: Date.now() - 2 * H });
  db.raw.exec(`DELETE FROM sig WHERE k='usage'`);
  assert.equal((await K.evaluateDecision(db, 'K3')).status, 'unmeasured');
  const h = await K.decisionHealth(db);
  assert.equal(h.parsable_share_7d, 1);
});

test('allocation: risks 120/40/20/15/5 with T=25 give 10/5/4/3/3 (US-03-T06); escalation keeps the total at T', () => {
  const mkp = (risks, extra = {}) => risks.map(([id, risk]) => ({ id, risk, open: 5, ...(extra[id] || {}) }));
  const base = K.allocateSlots(mkp([['OPS', 120], ['INFRA', 40], ['REACH', 20], ['RSCH', 15], ['PRIVATE', 5]]), 25);
  assert.deepEqual(Object.values(base).map(v => v.slots), [10, 5, 4, 3, 3]);
  assert.equal(base.OPS.class, 'constrain');
  const esc = K.allocateSlots(mkp([['OPS', 120], ['INFRA', 40], ['REACH', 20], ['RSCH', 15], ['PRIVATE', 5]], { INFRA: { escalate: true } }), 25);
  assert.equal(esc.INFRA.slots, 7); assert.equal(esc.INFRA.class, 'escalate');
  assert.equal(Object.values(esc).reduce((s, v) => s + v.slots, 0), 25);
  assert.equal(K.allocateSlots([{ id: 'A', risk: 0, open: 0 }], 25).A.class, 'idle');
});

test('snapshot, allocation, decision log and focus: items without a doer rank first within a tier', async () => {
  const db = mk(); const set = await setup(db);
  set('usage', 10); set('errors', 0); // primary metric in breach -> RED
  await K.registerProgram(db, { id: 'p1', name: 'P1', primary_metric_id: 'usage' });
  await K.registerProgram(db, { id: 'p2', name: 'P2' });
  db.raw.exec(`INSERT INTO items (id,title,owner_role,done_check,priority,status,project) VALUES
    ('a','has doer','staff','x',10,'ready','p1'), ('b','no doer','staff','x',10,'ready','p1'), ('c','metric','staff','x',40,'ready','p1'), ('z','other','staff','x',10,'ready','p2');
    INSERT INTO kernel_item_meta (item_id, doer) VALUES ('a','agent-1');
    INSERT INTO kernel_item_meta (item_id, metric_id) VALUES ('c','usage');`);
  await K.readAllMetrics(db);
  const snap = await K.snapshotRisk(db, { tickId: 1, now: Date.now() });
  assert.equal(snap.find(s => s.program_id === 'p1').verdict, 'RED');
  const alloc = await K.allocate(db, { tickId: 1, now: Date.now() });
  assert.ok(alloc.p1.slots + alloc.p2.slots <= 25);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM kernel_decisions WHERE id='ALLOC-1'").get().n, 1);
  await K.setFocus(db, { tickId: 1, now: Date.now() });
  const f = db.raw.prepare("SELECT item_id FROM kernel_focus WHERE program_id='p1' ORDER BY rank").all().map(r => r.item_id);
  assert.deepEqual(f, ['c', 'b', 'a']); // tier 0 first, then no-doer before has-doer
});

test('failure modes: a quiet detector writes a hit row (T01); firing opens an item with a contract; probe closes it', async () => {
  const db = mk(); db.raw.exec(`CREATE TABLE q (n INTEGER); INSERT INTO q VALUES (1);`);
  const contract = { owner: 'ops', doer: 'drain', alt_doers: ['drain-2'], closing_probe: 'SELECT COUNT(*) AS value FROM q', pass: '= 0', max_attempts: 2, backoff_h: [1, 4], deadline_h: 72 };
  await assert.rejects(() => K.registerFailureMode(db, { id: 'F', detector_sql: 'SELECT 1 AS value', fire_when: 'value > 0', severity: 3, contract: { owner: 'x' } }), /contract requires/);
  await K.registerFailureMode(db, { id: 'FM-Q', detector_sql: 'SELECT COUNT(*) AS value FROM q', fire_when: 'value > 5', severity: 3, contract });
  await K.runDetectors(db);
  assert.equal(db.raw.prepare('SELECT fired FROM kernel_failure_mode_hits').get().fired, 0);
  await K.registerFailureMode(db, { id: 'FM-Q', detector_sql: 'SELECT COUNT(*) AS value FROM q', fire_when: 'value > 0', severity: 3, contract });
  const fired = await K.runDetectors(db);
  assert.equal(fired.length, 1);
  const it = items(db, `id='${fired[0].item}'`)[0];
  assert.equal(it.owner_role, 'ops');
  const r1 = await K.consumeRemediations(db);
  assert.deepEqual([r1.scanned, r1.failed, r1.balanced], [1, 1, true]);
  assert.equal((await K.consumeRemediations(db)).no_action, 1); // backoff holds
  db.raw.exec('DELETE FROM q');
  const r2 = await K.consumeRemediations(db, { now: Date.now() + 2 * H });
  assert.equal(r2.executed, 1);
  assert.equal(items(db, `id='${fired[0].item}'`)[0].status, 'done');
});

test('fire_when can compare against expected; FM-FROZEN style stale detector is filed (T02)', async () => {
  const db = mk();
  const contract = { owner: 'ops', doer: 'd', closing_probe: 'SELECT 0 AS value', pass: '= 0', max_attempts: 3, backoff_h: [1], deadline_h: 24 };
  await K.registerFailureMode(db, { id: 'FM-COV', detector_sql: 'SELECT 2 AS value, 10 AS expected', fire_when: 'value < 0.8*expected', severity: 4, contract }, Date.now() - 10 * H);
  assert.equal((await K.runDetectors(db)).length, 1);
  await K.registerFailureMode(db, { id: 'FM-OLD', detector_sql: 'SELECT 0 AS value', fire_when: 'value > 0', severity: 1, contract }, Date.now() - 10 * H);
  const stale = await K.detectStaleDetectors(db);
  assert.deepEqual(stale.length, 1); assert.match(stale[0], /FM-STALE-FM-OLD/);
});

test('unaccounted loop run opens an incident and reopens items (T04); structured payload classification (T06)', async () => {
  const db = mk();
  db.raw.exec(`INSERT INTO items (id,title,owner_role,done_check,status,disposition) VALUES ('u1','x','s','d','done','ok')`);
  const r = await K.recordLoopRun(db, { loop: 'drain', scanned: 25, unaccounted_item_ids: ['u1'] });
  assert.equal(r.balanced, false); assert.ok(r.incident); assert.equal(r.reopened, 1);
  assert.equal(items(db, "id='u1'")[0].status, 'open');
  assert.equal(K.payloadIsFailure('{"queued":0,"failed":2,"published":19}'), false);
  assert.equal(K.payloadIsFailure('{"ok":false}'), true);
});

test('exhausted contract: interrupt-eligible goes to a gate card, otherwise is reassigned (US-17-R07)', async () => {
  const db = mk(); db.raw.exec(`CREATE TABLE q (n INTEGER); INSERT INTO q VALUES (1);`);
  const base = { owner: 'ops', doer: 'd1', alt_doers: ['d2'], closing_probe: 'SELECT COUNT(*) AS value FROM q', pass: '= 0', max_attempts: 1, backoff_h: [0], deadline_h: 72 };
  await K.registerFailureMode(db, { id: 'A', detector_sql: 'SELECT 1 AS value', fire_when: 'value > 0', severity: 2, contract: base });
  await K.registerFailureMode(db, { id: 'B', detector_sql: 'SELECT 1 AS value', fire_when: 'value > 0', severity: 2, contract: { ...base, interrupt_eligible: true } });
  await K.runDetectors(db);
  const r = await K.consumeRemediations(db);
  assert.equal(r.needs_human, 2); assert.equal(r.balanced, true);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM gate_cards').get().n, 1);
  assert.equal(db.raw.prepare("SELECT doer FROM kernel_remediations WHERE fm_id='A'").get().doer, 'd2');
});

test('loop breaker: 3 identical failures suspend retry, file a root cause, schedule a half-open probe (T03)', async () => {
  const db = mk(); const t = Date.now();
  for (let i = 0; i < 2; i++) assert.equal((await K.recordAttempt(db, { target: 'w', signature: 'E1', ok: false, now: t + i })).state, 'closed');
  const r = await K.recordAttempt(db, { target: 'w', signature: 'E1', ok: false, now: t + 3 });
  assert.equal(r.state, 'open'); assert.ok(r.half_open_at);
  assert.equal((await K.canAttempt(db, 'w', 'E1', t + 1000)).allowed, false);
  assert.equal(items(db, "id LIKE 'ROOTCAUSE-%'").length, 1);
  const later = t + 25 * H;
  assert.equal((await K.canAttempt(db, 'w', 'E1', later)).half_open, true);
  const fail = await K.recordAttempt(db, { target: 'w', signature: 'E1', ok: false, now: later });
  assert.equal(fail.extended, true);
  assert.equal((await K.canAttempt(db, 'w', 'E1', later + 30 * H)).allowed, false); // interval doubled to 48 h
  await K.recordAttempt(db, { target: 'w', signature: 'E1', ok: true, now: later + 60 * H });
  assert.equal((await K.canAttempt(db, 'w', 'E1', later + 60 * H)).allowed, true);
});

test('a remedy that did not move its metric is replaced, not repeated', async () => {
  const db = mk(); const set = await setup(db); set('usage', 50);
  await K.proposeRemedy(db, { id: 'R1', metric_id: 'usage', description: 'Add a banner', window_h: 1, now: Date.now() - 2 * H });
  await assert.rejects(() => K.proposeRemedy(db, { id: 'R2', metric_id: 'usage', description: 'other' }), /one remedy at a time/);
  const j = await K.judgeRemedies(db);
  assert.equal(j[0].status, 'replaced');
  assert.equal(items(db, "id='REMEDY-REPLACE-R1'").length, 1);
  await assert.rejects(() => K.proposeRemedy(db, { id: 'R3', metric_id: 'usage', description: '  add a   BANNER ' }), /repeats/);
  await K.proposeRemedy(db, { id: 'R4', metric_id: 'usage', description: 'Shorten the form', window_h: 1, now: Date.now() - 2 * H });
  set('usage', 80);
  assert.equal((await K.judgeRemedies(db))[0].status, 'effective');
});

// ---- lifecycle -------------------------------------------------------------------------------

async function fullPhase(db, id, phase, { doer = 'doer-a', reviewer = 'rev-b', check = 1 } = {}) {
  for (const c of K.CATALOG.filter(c => c.phase === phase)) {
    await K.submitArtifact(db, { project_id: id, kind: c.kind, path_or_ref: `docs/${c.kind}.md`, produced_by: doer, done_check: 'ok', done_check_passed: check });
    await K.reviewArtifact(db, { project_id: id, kind: c.kind, reviewer, verdict: 'approved' });
  }
}

test('lifecycle: planning gate creates items instead of erroring when artifacts are missing (T15-1)', async () => {
  const db = mk();
  await assert.rejects(() => K.createProject(db, { id: 'P', name: 'p', delivery_mode: 'agile', mode_reason: '' }), /reason/);
  await K.createProject(db, { id: 'P', name: 'p', delivery_mode: 'hybrid', mode_reason: 'default' });
  const r = await K.advancePhase(db, 'P', 'planning');
  assert.equal(r.ok, false); assert.ok(r.gate.missing.length === 6);
  assert.equal(items(db, "id LIKE 'GATE-P-A-INI-%'").length, 6);
  await fullPhase(db, 'P', 'initiating');
  assert.equal((await K.advancePhase(db, 'P', 'planning')).ok, true);
  await assert.rejects(() => K.advancePhase(db, 'P', 'closing'), /cannot move/);
  const g = await K.advancePhase(db, 'P', 'executing');
  assert.equal(g.ok, false); assert.equal(g.gate.missing.length, 10);
});

test('lifecycle: reviewer must differ from the doer (T15-2), by model family, and chat is not an artifact', async () => {
  const db = mk();
  await K.createProject(db, { id: 'P', name: 'p', delivery_mode: 'predictive', mode_reason: 'fixed order' });
  await assert.rejects(() => K.submitArtifact(db, { project_id: 'P', kind: 'A-INI-1', path_or_ref: 'chat: see above' }), /not chat/);
  await K.submitArtifact(db, { project_id: 'P', kind: 'A-INI-1', path_or_ref: 'docs/idea.md', produced_by: 'a', produced_model: 'alpha-1', done_check_passed: 1 });
  await assert.rejects(() => K.reviewArtifact(db, { project_id: 'P', kind: 'A-INI-1', reviewer: 'a', verdict: 'approved' }), /differ from doer/);
  await K.reviewArtifact(db, { project_id: 'P', kind: 'A-INI-1', reviewer: 'b', reviewer_model: 'beta-1', verdict: 'approved' });
  await K.submitArtifact(db, { project_id: 'P', kind: 'A-INI-2', path_or_ref: 'docs/c.md', produced_by: 'a', produced_model: 'alpha-1', done_check_passed: 1 });
  await assert.rejects(() => K.reviewArtifact(db, { project_id: 'P', kind: 'A-INI-2', reviewer: 'c', reviewer_model: 'alpha-2', verdict: 'approved' }), /model family/);
});

test('lifecycle: a gate does not pass on unreviewed or failing artifacts (phase theater)', async () => {
  const db = mk();
  await K.createProject(db, { id: 'P', name: 'p', delivery_mode: 'agile', mode_reason: 'unclear' });
  await fullPhase(db, 'P', 'initiating', { check: 0 });
  assert.deepEqual((await K.checkGate(db, 'P', 'G1')).failing.length, 6);
  await K.submitArtifact(db, { project_id: 'P', kind: 'A-INI-1', path_or_ref: 'x.md', produced_by: 'a', done_check_passed: 1 });
  assert.ok((await K.checkGate(db, 'P', 'G1')).unreviewed.includes('A-INI-1'));
});

test('lifecycle: change after a gate needs a change request with a revert path (T15-3); decider differs from requester', async () => {
  const db = mk();
  await K.createProject(db, { id: 'P', name: 'p', delivery_mode: 'hybrid', mode_reason: 'default' });
  await fullPhase(db, 'P', 'initiating');
  await K.advancePhase(db, 'P', 'planning');
  await assert.rejects(() => K.submitArtifact(db, { project_id: 'P', kind: 'A-INI-2', path_or_ref: 'new.md' }), /change request/);
  await assert.rejects(() => K.amendArtifact(db, { project_id: 'P', kind: 'A-INI-2', new_ref: 'new.md', summary: 's' }), /revert path/);
  const r = await K.amendArtifact(db, { project_id: 'P', kind: 'A-INI-2', new_ref: 'new.md', summary: 'widen scope', revert_path: 'restore docs/A-INI-2.md', requested_by: 'pm' });
  assert.equal(r.applied, false);
  assert.equal(db.raw.prepare('SELECT path_or_ref FROM artifacts WHERE kind=?').get('A-INI-2').path_or_ref, 'docs/A-INI-2.md');
  await assert.rejects(() => K.decideChangeRequest(db, r.change_request_id, { decision: 'approved', decided_by: 'pm' }), /differ/);
  await K.decideChangeRequest(db, r.change_request_id, { decision: 'approved', decided_by: 'portfolio' });
  const a = db.raw.prepare('SELECT * FROM artifacts WHERE kind=?').get('A-INI-2');
  assert.equal(a.path_or_ref, 'new.md'); assert.equal(a.status, 'submitted');
  assert.equal(db.raw.prepare('SELECT revert_path FROM change_requests').get().revert_path, 'restore docs/A-INI-2.md');
});

test('lifecycle: G2 needs read-back and probes; G3 fails with an item lacking a disposition (T15-6); lessons feed the plus queue', async () => {
  const db = mk();
  await K.createProject(db, { id: 'P', name: 'p', delivery_mode: 'hybrid', mode_reason: 'default' });
  await fullPhase(db, 'P', 'initiating'); await K.advancePhase(db, 'P', 'planning');
  await fullPhase(db, 'P', 'planning');
  db.raw.exec(`INSERT INTO items (id,title,owner_role,done_check,project,status) VALUES ('w1','w','staff','d','P','ready')`);
  let g = await K.checkGate(db, 'P', 'G2');
  assert.equal(g.pass, false); assert.ok(g.reasons.some(x => /read-back/.test(x))); assert.ok(g.reasons.some(x => /closing probe/.test(x)));
  await K.recordReadback(db, 'P'); db.raw.exec(`UPDATE items SET closing_probe='p' WHERE id='w1'`);
  assert.equal((await K.checkGate(db, 'P', 'G2')).pass, true);
  assert.equal((await K.advancePhase(db, 'P', 'executing')).ok, true);
  await K.advancePhase(db, 'P', 'closing');
  await fullPhase(db, 'P', 'closing');
  g = await K.checkGate(db, 'P', 'G3');
  assert.equal(g.pass, false); assert.ok(g.reasons.some(x => /no disposition/.test(x)));
  const l = await K.addLesson(db, { project_id: 'P', text: 'plan smaller' });
  assert.equal(items(db, `id='${l.plus_item_id}'`)[0].kind, 'plus');
  db.raw.exec(`UPDATE items SET disposition='moved to backlog' WHERE project='P'`);
  assert.equal((await K.advancePhase(db, 'P', 'closed')).ok, true);
  assert.ok(await K.addRisk(db, { project_id: 'P', cause: 'c', effect: 'e' }));
});

// ---- tick integration ------------------------------------------------------------------------

test('runL2 plugs into runTick via extraSteps without changing the seven L1 steps', async () => {
  const db = mk(); const set = await setup(db); set('usage', 5); set('errors', 0);
  await K.registerProgram(db, { id: 'p1', name: 'P1', primary_metric_id: 'usage' });
  db.raw.exec(`INSERT INTO items (id,title,owner_role,done_check,priority,status,project) VALUES ('a','a','staff','d',5,'ready','p1')`);
  const plain = await runTick(makeDb(), { config: config() });
  assert.equal(plain.total, STEP_ORDER.length);
  const r = await runTick(db, { config: config(), extraSteps: K.L2_EXTRA_STEPS });
  assert.equal(r.total, STEP_ORDER.length + 1); assert.equal(r.completed, r.total); assert.deepEqual(r.errors, []);
  const ev = db.raw.prepare('SELECT step, ok FROM kernel_step_evidence WHERE tick_id = ?').all(r.tickId);
  assert.deepEqual(ev.map(e => e.step), K.L2_STEP_NAMES);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM kernel_focus').get().n, 1);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM kernel_decisions').get().n, 1);
});

test('manager_ops=false stops operations but measurement continues (US-03-R14); a missing evidence slot is detected (R11)', async () => {
  const db = mk(); const set = await setup(db); set('usage', 5); set('errors', 0);
  await K.registerProgram(db, { id: 'p1', name: 'P1' });
  const r = await runTick(db, { config: config({ manager_ops: false }), extraSteps: K.L2_EXTRA_STEPS });
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM kernel_metric_readings').get().n, 2);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM kernel_risk_snapshot').get().n, 1);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM kernel_allocations').get().n, 0);
  db.raw.prepare("DELETE FROM kernel_step_evidence WHERE step = 'focus'").run();
  await runTick(db, { config: config(), extraSteps: K.L2_EXTRA_STEPS });
  assert.equal(items(db, `id = 'L2MISSING-${r.tickId}'`).length, 1);
});

test('a failing L2 sub-step is guarded and filed as a TICKFAIL item', async () => {
  const db = mk();
  db.raw.exec('DROP TABLE kernel_programs');
  const r = await runTick(db, { config: config(), extraSteps: K.L2_EXTRA_STEPS });
  assert.equal(r.completed, STEP_ORDER.length + 1);
  assert.ok(r.errors.some(e => /risk_snapshot/.test(e)));
  assert.ok(items(db, "id LIKE 'TICKFAIL-l2_risk_snapshot%'").length >= 1);
});
