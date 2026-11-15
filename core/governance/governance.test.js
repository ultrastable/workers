// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import * as G from './index.js';
import * as Trust from '../trust/index.js';

const MIG = fileURLToPath(G.MIGRATIONS_DIR);
const TRUST_MIG = fileURLToPath(Trust.MIGRATIONS_DIR);
const POLICY = JSON.parse(readFileSync(new URL('../../autonomy/policy.json', import.meta.url), 'utf8'));
const NOW = Date.UTC(2026, 10, 11, 10, 0, 0);
const H = 3600e3, DAY = 86400e3;
async function mk() { const db = makeDb([MIG, TRUST_MIG]); await G.seedRegister(db, { now: NOW - 30 * DAY }); return db; }
const one = (db, sql, ...a) => db.raw.prepare(sql).get(...a);
const rows = (db, sql, ...a) => db.raw.prepare(sql).all(...a);
const T01 = "The timeout is fixed. Let me know if you'd like me to open the pull request?";
const openPr = { execute: async (action) => ({ verified: true, ref: 'PR-42', statement: `The pull request is open: PR-42 (${action.summary}).` }) };

test('migration is idempotent, tables are governance_ prefixed, and the register is seeded once with the ten shapes as rows', async () => {
  const db = await mk();
  const sql = readFileSync(MIG + '0001_governance.sql', 'utf8');
  db.raw.exec(sql); db.raw.exec(sql);
  for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) assert.match(m[1], /^governance_/);
  assert.equal(await G.seedRegister(db), 10);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM governance_lineage`).n, 1);
  assert.equal(one(db, `SELECT version FROM governance_lineage`).version, '0.1.0');
  // a signature is a row: a new one works without a code change
  db.raw.prepare(`INSERT INTO governance_false_stop_register (pattern_key, pattern, cause_class, detection_heuristic, auto_remediation) VALUES ('apology','Apology loop','noise','phrase','state the result')`).run();
  db.raw.prepare(`INSERT INTO governance_false_stop_phrases (pattern_key, phrase) VALUES ('apology','sorry for the confusion')`).run();
  const r = await G.recognize(db, { draft: 'Sorry for the confusion. Tests pass.', source: 'doer-1' }, { now: NOW });
  assert.deepEqual(r.hits.map(h => h.pattern_key), ['apology']);
});

test('US-07-T01 the conditional offer is executed: the output states the pull request is open with its identifier read back, two hits are recorded, no question is emitted', async () => {
  const db = await mk();
  const r = await G.recognize(db, { draft: T01, source: 'doer-1', ctx: { action: { kind: 'open_pull_request', summary: 'timeout fix' } } }, { ...openPr, now: NOW });
  assert.equal(r.emitted, 'The timeout is fixed. The pull request is open: PR-42 (timeout fix).');
  assert.ok(!r.emitted.includes('?') && !/let me know/i.test(r.emitted));
  assert.deepEqual(rows(db, `SELECT pattern_key, excluded, source FROM governance_false_stop_hits ORDER BY pattern_key`).map(h => [h.pattern_key, h.excluded, h.source]), [['conditional_offer', 0, 'doer-1'], ['question_ending', 0, 'doer-1']]);
  assert.deepEqual(r.executed, { ref: 'PR-42' });
});

test('US-07-R06 a rewritten output is true when emitted: an unverified execution is reported as a dispatch or as an open item, never as done', async () => {
  const db = await mk();
  const ctx = { action: { kind: 'open_pull_request', summary: 'open the pull request for the timeout fix' }, surface: 'repo', action_class: 'open_pr' };
  const fails = { execute: async () => ({ verified: false, evidence: 'push rejected: branch protection' }), now: NOW };
  const item = await G.recognize(db, { draft: T01, source: 'doer-1', ctx }, fails);
  assert.match(item.emitted, /^The timeout is fixed\. Open item FALSESTOP-\d+: open the pull request for the timeout fix is not done \(push rejected: branch protection\)\.$/);
  assert.deepEqual({ ...one(db, `SELECT status, owner_role, surface FROM items WHERE id=?`, item.item) }, { status: 'ready', owner_role: 'operations', surface: 'repo' });
  const disp = await G.recognize(db, { draft: T01, source: 'doer-1', ctx }, { ...fails, dispatch: async () => ({ dispatched: true, to: 'doer-2', ref: 'DISP-9' }) });
  assert.equal(disp.emitted, 'The timeout is fixed. Dispatched to doer-2 as DISP-9: open the pull request for the timeout fix.');
  const claims = await G.recognize(db, { draft: T01, source: 'doer-1', ctx }, { execute: async () => ({ verified: true }), now: NOW });
  assert.match(claims.emitted, /Open item FALSESTOP/, 'a "verified" result with nothing to read back is not stated as done');
  const noAction = await G.recognize(db, { draft: T01, source: 'doer-1' }, { ...openPr, now: NOW });
  assert.match(noAction.emitted, /is not done \(the abandoned step was not named\)/);
  const throws = await G.recognize(db, { draft: T01, source: 'doer-1', ctx }, { execute: async () => { throw new Error('api down'); }, now: NOW });
  assert.match(throws.emitted, /execution failed: api down/);
});

test('US-07-T02 "I can\'t push; the token has no access." with no surface list records a deduction; with surfaces each is enumerated and tested', async () => {
  const db = await mk();
  const ctx = { surface: 'repo', action_class: 'branch_commit_push', agent: 'doer-1', action: { kind: 'push', summary: 'push the branch' } };
  const none = await G.recognize(db, { draft: "I can't push; the token has no access.", source: 'doer-1', ctx }, { now: NOW });
  assert.deepEqual(none.hits.map(h => h.pattern_key), ['blocker_no_surfaces']);
  assert.deepEqual(none.deductions.map(d => d.weight), [-0.10, -0.10], 'the hit, and the missing surface coverage');
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM governance_deductions WHERE pattern_key='blocker_no_surfaces'`).n, 2);
  assert.match(none.emitted, /^No surface was tested for this blocker\. Open item FALSESTOP-/);
  const used = [];
  const surfaces = [{ name: 'cli', test: async () => ({ ok: false, detail: '403' }) }, { name: 'rest-api', test: async () => ({ ok: true }) }, { name: 'ci-workflow', test: async () => { throw new Error('not configured'); } }];
  const some = await G.recognize(db, { draft: "I can't push; the token has no access.", source: 'doer-1', ctx: { ...ctx, surfaces } },
    { now: NOW, execute: async (a) => { used.push(a.surface); return { verified: true, ref: 'abc1234', statement: 'The branch is pushed at abc1234.' }; } });
  assert.deepEqual(some.surfaces.map(s => [s.name, s.ok]), [['cli', false], ['rest-api', true], ['ci-workflow', false]]);
  assert.deepEqual(used, ['rest-api']);
  assert.equal(some.emitted, 'Surfaces tested: cli failed (403); rest-api works; ci-workflow failed (not configured). The branch is pushed at abc1234.');
  const allFail = await G.recognize(db, { draft: 'Deploy refused.', source: 'doer-1', ctx: { ...ctx, surfaces: [surfaces[0]] } }, { now: NOW, execute: async () => { throw new Error('must not run'); } });
  assert.match(allFail.emitted, /is not done \(every tested surface failed\)/);
});

test('US-07-R05, US-07-R07 a refusal with its reason, an interrupt-eligible stop and another agent\'s live claim are excluded from redirect, reported as dispositions and still recorded', async () => {
  const db = await mk();
  db.raw.prepare(`INSERT INTO items (id, title, owner_role, done_check, status) VALUES ('I1','t','operations','d','claimed')`).run();
  db.raw.prepare(`INSERT INTO claims (item_id, agent) VALUES ('I1','doer-9')`).run();
  let ran = 0;
  const ports = { execute: async () => { ran++; return { verified: true, statement: 'done' }; }, now: NOW };
  const cases = [
    [{ refusal: { check: 'classifier', reason: 'the text names a living person' } }, /^refusal by classifier: the text names a living person$/],
    [{ interrupt_eligible: true, gate_card: 'GATE-money-spend' }, /^interrupt-eligible step$/],
    [{ item_id: 'I1', agent: 'doer-1' }, /^live claim of doer-9 on I1$/],
  ];
  for (const [ctx, why] of cases) {
    const r = await G.recognize(db, { draft: 'I cannot publish this. Shall I wait?', source: 'doer-1', ctx: { ...ctx, surface: 'repo', action_class: 'open_pr', action: { kind: 'publish' } } }, ports);
    assert.equal(r.excluded, true); assert.match(r.exclusion_reason, why);
    assert.match(r.emitted, /^I cannot publish this\. Shall I wait\?\nDisposition: .*; owner .*; closing probe: .*\.$/);
    assert.deepEqual(r.deductions, []);
  }
  assert.equal(ran, 0, 'nothing is re-executed for an excluded hit');
  const hits = rows(db, `SELECT excluded, exclusion_reason FROM governance_false_stop_hits`);
  assert.equal(hits.length, 9); assert.ok(hits.every(h => h.excluded === 1 && h.exclusion_reason));
  // the claim holder itself is not excluded
  const own = await G.recognize(db, { draft: 'Shall I merge?', source: 'doer-9', ctx: { item_id: 'I1', agent: 'doer-9' } }, { now: NOW });
  assert.equal(own.excluded, false);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM governance_false_stop_hits WHERE excluded=0`).n, 2);
});

test('fenced and quoted text is masked: a phrase inside a quotation or a code block is not a hit', async () => {
  const db = await mk();
  const draft = 'The log said "let me know if the disk fills" and the script prints:\n```\necho "shall I continue?"\n```\n> you should run it\nThe patch is merged as `if you want`.';
  const r = await G.recognize(db, { draft, source: 'doer-1' }, { now: NOW });
  assert.deepEqual(r.hits, []); assert.equal(r.emitted, draft);
  assert.equal(G.mask(draft).length, draft.length);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM governance_scans`).n, 1, 'the scan is stored even with no hit');
});

test('event-weighted trust deductions per recognition: each non-excluded hit deducts its weight on the pair, and the trust score falls by it', async () => {
  const db = await mk();
  const st = db.raw.prepare(`INSERT INTO outcomes (surface, action_class, result, at) VALUES ('repo','open_pr',?, '2026-11-11 10:00:00')`);
  for (let i = 0; i < 8; i++) st.run('verified'); for (let i = 0; i < 2; i++) st.run('failed');
  const before = (await Trust.recompute(db, { policy: POLICY, now: NOW }))[0].score;
  const deduct = (d) => Trust.recordEvent(db, d, { now: NOW });
  const r = await G.recognize(db, { draft: 'You should rotate the key. The fix is to edit the config.', source: 'doer-1', ctx: { surface: 'repo', action_class: 'open_pr', agent: 'doer-1' } }, { now: NOW, deduct });
  assert.deepEqual(r.deductions.map(d => [d.event, d.weight]), [['narration', -0.05], ['principal_actor', -0.10]].map(([k, w]) => [k === 'narration' ? 'unnecessary_question' : 'handoff_of_executable_step', w]));
  assert.deepEqual(rows(db, `SELECT pattern_key, weight FROM governance_deductions ORDER BY pattern_key`).map(x => [x.pattern_key, x.weight]), [['narration', -0.05], ['principal_actor', -0.10]]);
  const after = (await Trust.recompute(db, { policy: POLICY, now: NOW })).find(x => x.executor === '').score;
  assert.ok(Math.abs((before - after) - 0.15) < 1e-9);
  const ex = await G.recognize(db, { draft: 'You should rotate the key.', source: 'doer-1', ctx: { surface: 'repo', action_class: 'open_pr', interrupt_eligible: true } }, { now: NOW, deduct });
  assert.deepEqual(ex.deductions, [], 'an excluded hit deducts nothing');
});

test('US-07-R17 the pre-emission filter returns a revision request at most R times (default 2), then the engine handles what still hits', async () => {
  const db = await mk();
  const asked = [];
  const fixes = { revise: async (req) => { asked.push(req.hits.map(h => h.pattern_key).join('+')); return 'The timeout is fixed and the pull request PR-42 is open.'; }, now: NOW };
  const clean = await G.preEmit(db, { draft: T01, source: 'doer-1' }, fixes);
  assert.deepEqual([clean.revisions, clean.emitted, clean.hits.length], [1, 'The timeout is fixed and the pull request PR-42 is open.', 0]);
  assert.deepEqual(asked, ['conditional_offer+question_ending']);
  let n = 0;
  const stubborn = await G.preEmit(db, { draft: T01, source: 'doer-1', ctx: { action: { kind: 'open_pull_request', summary: 'timeout fix' } } }, { ...openPr, revise: async () => `Attempt ${++n}: shall I open it?`, now: NOW });
  assert.deepEqual([stubborn.revisions, n], [2, 2]);
  assert.equal(stubborn.emitted, 'The pull request is open: PR-42 (timeout fix).');
  const one_ = await G.preEmit(db, { draft: T01, source: 'doer-1' }, { revise: async () => `again ${++n}?`, maxRevisions: 1, now: NOW });
  assert.equal(one_.revisions, 1);
  const quoted = await G.preEmit(db, { draft: 'The reviewer wrote "shall I approve?" and then approved.', source: 'doer-1' }, { revise: async () => { throw new Error('must not be asked'); }, now: NOW });
  assert.deepEqual([quoted.revisions, quoted.hits.length], [0, 0], 'quoted text is masked before matching');
});

test('classifier-port matching: a signature the phrases miss is a hit when the classifier port returns it above the threshold; an outage leaves phrases in force', async () => {
  const db = await mk();
  const seen = [];
  const classifier = async (masked, patterns) => { seen.push({ masked, n: patterns.length }); return [{ pattern_key: 'conditional_offer', score: 0.9, excerpt: 'Happy to proceed whenever suits' }, { pattern_key: 'menu', score: 0.2 }]; };
  const r = await G.recognize(db, { draft: 'Happy to proceed whenever suits. "secret quote"', source: 'doer-1', ctx: { action: { kind: 'proceed', summary: 'apply the change' } } }, { classifier, now: NOW });
  assert.deepEqual(r.hits.map(h => h.pattern_key), ['conditional_offer']);
  assert.ok(!seen[0].masked.includes('secret quote') && seen[0].n === 10, 'the classifier sees the masked text and the active signatures');
  assert.match(r.emitted, /Open item FALSESTOP/);
  const down = await G.recognize(db, { draft: 'Shall I go on?', source: 'doer-1' }, { classifier: async () => { throw new Error('model 503'); }, now: NOW });
  assert.deepEqual([down.hits.map(h => h.pattern_key).sort(), down.classifier_error], [['conditional_offer', 'question_ending'], 'model 503']);
});

test('state signature silent_drop: an item that left the active set with no disposition is a hit, once', async () => {
  const db = await mk();
  db.raw.prepare(`INSERT INTO items (id, title, owner_role, done_check, status, disposition) VALUES ('A','t','operations','d','done',NULL), ('B','t','operations','d','done','done: observed')`).run();
  assert.deepEqual(await G.scanState(db, { now: NOW }), ['A']);
  assert.deepEqual(await G.scanState(db, { now: NOW }), []);
});

async function threeHits(db, source = 'doer-1') {
  for (let i = 0; i < 3; i++) await G.recognize(db, { draft: `Step ${i} is ready. Shall I continue`, source }, { now: NOW - (3 - i) * DAY });
}

test('threshold-generated proposals: a signature hitting 3 times in 7 days from one source, or a friction phrase once, raises one proposal', async () => {
  const db = await mk();
  await G.recognize(db, { draft: 'Shall I continue', source: 'doer-2' }, { now: NOW - DAY });
  await G.recognize(db, { draft: 'Shall I continue', source: 'doer-2' }, { now: NOW - 2 * DAY });
  await G.recognize(db, { draft: 'Shall I continue', source: 'doer-2' }, { now: NOW - 9 * DAY }); // outside the window
  assert.deepEqual(await G.scanThresholds(db, { now: NOW }), [], 'two in the window from doer-2 is under the threshold');
  await threeHits(db);
  assert.deepEqual(await G.scanThresholds(db, { now: NOW }), ['AMEND-conditional_offer-doer-1-2026-11-11']);
  assert.deepEqual(await G.scanThresholds(db, { now: NOW }), [], 'one open proposal per signature and source');
  const p = one(db, `SELECT origin, status, evidence FROM governance_proposals`);
  assert.deepEqual([p.origin, p.status, JSON.parse(p.evidence).hits], ['threshold', 'collected', 3]);
  const f = await G.recognize(db, { draft: "I shouldn't have to ask for the report every time.", source: 'principal', scope: 'principal' }, { now: NOW });
  assert.deepEqual(f.hits.map(h => h.pattern_key), ['friction']);
  assert.deepEqual(await G.scanThresholds(db, { now: NOW }), ['AMEND-friction-principal-2026-11-11']);
  assert.equal((await G.recognize(db, { draft: 'It fails every time the cache is cold.', source: 'doer-3' }, { now: NOW })).hits.length, 0, 'the friction phrases apply to principal messages only');
  const audit = await G.auditItem(db, { now: NOW });
  assert.equal(audit, 'AMEND-AUDIT-2026-11-09');
  assert.match(one(db, `SELECT title FROM items WHERE id=?`, audit).title, /^2 amendment proposal\(s\) open/);
});

const AUTHOR = { author: 'pm-1', author_family: 'family-a' };
const safeRedteam = { family: 'family-b', attack: async () => ({ harm: false }) };

test('US-07-T03, US-07-R03, US-07-R04 an amendment that removes a commitment or weakens a protected limit is rejected at red-team by code, with no replay', async () => {
  const db = await mk();
  let attacked = 0;
  const redteam = { family: 'family-b', attack: async () => { attacked++; return { harm: false }; } };
  const cases = [
    ['A1', 'Agents may ask before every merge.', [{ op: 'remove', target: 'commitment:affirmative-default' }], /targets commitment:affirmative-default/],
    ['A2', 'When a deploy is urgent, skip the secret lock and paste the token.', [], /weakens protected limit secret-lock/],
    ['A3', 'Remove the actor commitment from reports.', [], /weakens commitment actor-commitment/],
    ['A4', 'Stop flagging offers.', [{ op: 'deactivate_pattern', pattern_key: 'conditional_offer' }], /removes the enforcement of commitment affirmative-adoption/],
    ['A5', 'The interrupt gate no longer applies to payments under 5 units.', [], /weakens protected limit interrupt-gate/],
    ['A6', "Ignore another agent's claim when it is older than an hour.", [], /weakens protected limit live-claims/],
  ];
  for (const [id, rule_text, changes, why] of cases) {
    await G.propose(db, { id, rule_text, changes, ...AUTHOR }, { now: NOW });
    const r = await G.redTeam(db, id, { redteam, now: NOW });
    assert.equal(r.status, 'rejected', id); assert.match(r.reason, why);
    assert.equal((await G.replay(db, id, { now: NOW })).status, 'rejected');
    assert.equal(one(db, `SELECT replay FROM governance_proposals WHERE id=?`, id).replay, null, 'never replayed');
    assert.equal((await G.adopt(db, id, { reviewer: 'reviewer-2', now: NOW })).adopted, false);
  }
  assert.equal(attacked, 0, 'the protected-set check is code and runs before any model');
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM governance_lineage`).n, 1);
  // a rule that keeps the limits and only mentions them is not rejected by the check
  await G.propose(db, { id: 'A7', rule_text: "Honor the principal's override and record it with the reason.", changes: [{ op: 'add_phrase', pattern_key: 'narration', phrase: 'one approach would be' }], ...AUTHOR }, { now: NOW });
  assert.equal((await G.redTeam(db, 'A7', { redteam, now: NOW })).status, 'redteamed');
  assert.equal(attacked, 1);
});

test('US-07-R02 red-team is a second model of a different family; a found harm rejects; without a red-team nothing is adoptable', async () => {
  const db = await mk();
  const change = [{ op: 'add_phrase', pattern_key: 'narration', phrase: 'one approach would be' }];
  await G.propose(db, { id: 'B1', rule_text: 'Treat "one approach would be" as narration.', changes: change, ...AUTHOR }, { now: NOW });
  assert.match((await G.redTeam(db, 'B1', { redteam: { family: 'family-a', attack: async () => ({ harm: false }) }, now: NOW })).reason, /different family/);
  assert.match((await G.redTeam(db, 'B1', { now: NOW })).reason, /no red-team model/);
  assert.match((await G.redTeam(db, 'B1', { redteam: { family: 'family-b', attack: async () => { throw new Error('503'); } }, now: NOW })).reason, /red-team outage: 503/);
  assert.equal(one(db, `SELECT status FROM governance_proposals WHERE id='B1'`).status, 'generated');
  assert.match((await G.replay(db, 'B1', { now: NOW })).reason, /only after a red-team/);
  assert.equal((await G.adopt(db, 'B1', { reviewer: 'reviewer-2', now: NOW })).adopted, false);
  const harm = await G.redTeam(db, 'B1', { redteam: { family: 'family-b', attack: async () => ({ harm: true, case: 'a refusal report quoting an approach would be rewritten' }) }, now: NOW });
  assert.deepEqual([harm.status, harm.reason], ['rejected', 'red-team found harm: a refusal report quoting an approach would be rewritten']);
});

async function judged(db, draft, label, at) {
  const r = await G.recognize(db, { draft, source: 'doer-1' }, { now: at });
  await G.labelScan(db, r.scan_id, label);
}

test('US-07-R02, US-07-R01 replay against stored scans and ticks: an amendment that catches missed false stops and worsens nothing is adopted by review, the version increments and lineage rows are written', async () => {
  const db = await mk();
  for (let i = 0; i < 4; i++) db.raw.prepare(`INSERT INTO tick_runs (started_at, steps_total) VALUES (?, 8)`).run(new Date(NOW - (i + 1) * DAY).toISOString().replace('T', ' ').slice(0, 19));
  await judged(db, 'One approach would be to raise the limit.', 1, NOW - 3 * DAY);
  await judged(db, 'One approach would be to split the job.', 1, NOW - 2 * DAY);
  await judged(db, 'The limit is raised to 50 and the probe passes.', 0, NOW - DAY);
  await judged(db, 'One approach would be to wait.', 1, NOW - 20 * DAY); // outside the 7-day window
  await G.propose(db, { id: 'C1', rule_text: 'Treat "one approach would be" as narration: produce the artifact.', changes: [{ op: 'add_phrase', pattern_key: 'narration', phrase: 'one approach would be' }], ...AUTHOR }, { now: NOW });
  await G.redTeam(db, 'C1', { redteam: safeRedteam, now: NOW });
  const r = await G.replay(db, 'C1', { now: NOW });
  assert.equal(r.status, 'replayed');
  assert.deepEqual([r.before, r.after, r.improved, r.worsened], [{ missed_false_stops: 2, false_positives: 0 }, { missed_false_stops: 0, false_positives: 0 }, ['missed_false_stops'], []]);
  assert.deepEqual([r.window.ticks, r.window.scans, r.window.judged], [4, 3, 3]);
  assert.equal((await G.recognize(db, { draft: 'One approach would be to retry.', source: 'x' }, { now: NOW })).hits.length, 0, 'a replay changes nothing in force');
  assert.deepEqual(await G.adopt(db, 'C1', { reviewer: 'pm-1', now: NOW }), { id: 'C1', adopted: false, reason: 'the reviewer is the author' });
  assert.equal((await G.adopt(db, 'C1', { now: NOW })).reason, 'no reviewer named');
  const a = await G.adopt(db, 'C1', { reviewer: 'reviewer-2', now: NOW });
  assert.deepEqual([a.adopted, a.version, a.parent], [true, '0.1.1', '0.1.0']);
  assert.match(a.report, /commitments unchanged/);
  const lin = rows(db, `SELECT version, parent_version, proposal_id, adopted_by, commitments_hash FROM governance_lineage ORDER BY version`);
  assert.deepEqual(lin.map(l => [l.version, l.parent_version, l.proposal_id, l.adopted_by]), [['0.1.0', null, null, 'seed'], ['0.1.1', '0.1.0', 'C1', 'reviewer-2']]);
  assert.equal(lin[0].commitments_hash, lin[1].commitments_hash);
  assert.deepEqual({ ...one(db, `SELECT version, source FROM doctrine_lineage`) }, { version: 'governance-0.1.1', source: 'amendment C1 reviewed by reviewer-2' });
  assert.deepEqual((await G.recognize(db, { draft: 'One approach would be to retry.', source: 'x' }, { now: NOW })).hits.map(h => h.pattern_key), ['narration'], 'the adopted rule is in force');
  assert.equal((await G.adopt(db, 'C1', { reviewer: 'reviewer-3', now: NOW })).adopted, false, 'adopted once');
});

test('replay rejects an amendment that worsens a metric beyond tolerance or improves none; without judged records nothing is adopted', async () => {
  const db = await mk();
  await judged(db, 'The service is up and the probe passes.', 0, NOW - DAY);
  await judged(db, 'One approach would be to raise the limit.', 1, NOW - DAY);
  const go = async (id, changes, opts = {}) => {
    await G.propose(db, { id, rule_text: `rule ${id}`, changes, ...AUTHOR }, { now: NOW });
    await G.redTeam(db, id, { redteam: safeRedteam, now: NOW });
    return G.replay(db, id, { now: NOW, ...opts });
  };
  const broad = await go('D1', [{ op: 'add_phrase', pattern_key: 'narration', phrase: 're:\\bthe\\b' }]);
  assert.deepEqual([broad.status, broad.reason], ['rejected', 'replay worsens false_positives']);
  const idle = await go('D2', [{ op: 'add_phrase', pattern_key: 'narration', phrase: 'never appears anywhere' }]);
  assert.deepEqual([idle.status, idle.reason], ['rejected', 'replay improves no metric']);
  assert.equal((await go('D3', [{ op: 'add_phrase', pattern_key: 'narration', phrase: 're:(' }])).status, 'rejected', 'a bad expression is rejected at replay, not found at emission');
  const tolerated = await go('D4', [{ op: 'add_phrase', pattern_key: 'narration', phrase: 're:\\bthe\\b' }], { tolerance: 1 });
  assert.equal(tolerated.status, 'replayed');
  // a change of another kind needs the evaluate port
  const policy = [{ op: 'policy', path: 'ladder.promote_when.min_outcomes', value: 12 }];
  assert.match((await go('D5', policy)).reason, /needs an evaluate port/);
  const ev = await G.replay(db, 'D5', { now: NOW, evaluate: async ({ window }) => ({ before: { wrong_promotions: 3 }, after: { wrong_promotions: 1 }, ticks: window.ticks }) });
  assert.deepEqual([ev.status, ev.improved], ['replayed', ['wrong_promotions']]);
  const empty = await mk();
  await G.propose(empty, { id: 'E1', rule_text: 'rule', changes: [{ op: 'add_phrase', pattern_key: 'narration', phrase: 'x y z' }], ...AUTHOR }, { now: NOW });
  await G.redTeam(empty, 'E1', { redteam: safeRedteam, now: NOW });
  const none = await G.replay(empty, 'E1', { now: NOW });
  assert.deepEqual([none.status, none.reason], ['redteamed', 'no judged records in the window to replay against']);
  assert.equal((await G.adopt(empty, 'E1', { reviewer: 'reviewer-2', now: NOW })).adopted, false);
});

test('the loop end to end: hits raise a proposal, a model writes the rule, a second family red-teams it, replay scores it; adoption stays a reviewed change', async () => {
  const db = await mk();
  await threeHits(db);
  for (const s of rows(db, `SELECT id FROM governance_scans`)) await G.labelScan(db, s.id, 1);
  await judged(db, 'Should I go ahead with step 4', 1, NOW - H);
  const generate = async (p) => ({ rule_text: `Signature ${p.pattern_key} from ${p.source}: also match "should i".`, changes: [{ op: 'add_phrase', pattern_key: 'conditional_offer', phrase: 'should i' }], author: 'generator-1', family: 'family-a' });
  const r = await G.amendStep(db, { now: NOW, generate, redteam: safeRedteam });
  assert.deepEqual([r.raised, r.generated, r.results.map(x => x.status)], [['AMEND-conditional_offer-doer-1-2026-11-11'], ['AMEND-conditional_offer-doer-1-2026-11-11'], ['redteamed', 'replayed']]);
  assert.equal(one(db, `SELECT status FROM governance_proposals`).status, 'replayed');
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM governance_lineage`).n, 1, 'the loop does not adopt by itself');
  assert.equal((await G.adopt(db, r.raised[0], { reviewer: 'reviewer-2', now: NOW })).version, '0.1.1');
  const s = await G.step({ db, now: NOW });
  assert.deepEqual([s.proposals_raised, s.audit], [[], null]);
  assert.ok(s.rates.false_stop_rate > 0 && s.rates.conditional_offer_rate > 0 && s.rates.narration_rate === 0);
});

test('US-07-R16 a configuration or prompt without the commitments is rejected; one that carries the block loads', () => {
  const block = G.commitmentsBlock();
  assert.equal(G.COMMITMENTS.length, 5);
  assert.deepEqual(G.missingCommitments(`You are the doer.\n${block}`), []);
  assert.equal(G.loadLoopPrompt({ name: 'doer', prompt: `You are the doer.\n${block}` }).name, 'doer');
  assert.throws(() => G.loadLoopPrompt({ name: 'doer', prompt: 'You are the doer. Be helpful.' }), /commitments missing: interrupt-gate, alignment-floor, affirmative-adoption, affirmative-default, actor-commitment/);
  const cut = block.split('\n').filter(l => !l.includes('actor-commitment')).join('\n');
  assert.throws(() => G.loadLoopPrompt({ name: 'doer', prompt: cut }), /commitments missing: actor-commitment$/);
  const altered = block.replace('irreversible and identity-bound', 'inconvenient');
  assert.deepEqual(G.missingCommitments(altered), ['interrupt-gate'], 'a reworded commitment is a missing commitment');
});

test('US-07-T06, US-07-R14 an agent cannot write a ratified objective, and an objective revision is refused status adopted or active by code', async () => {
  const db = await mk();
  await assert.rejects(G.ratifyObjective(db, { id: 'O1', text: 'Keep the service reliable', by: 'pm-1' }), /only by the principal or a ratification action/);
  await assert.rejects(G.ratifyObjective(db, { id: 'O1', text: 'Keep the service reliable', by: 'ratification' }), /only by the principal/);
  await G.ratifyObjective(db, { id: 'O1', text: 'Keep the service reliable and fast', by: 'principal' }, { now: NOW });
  await G.proposeRevision(db, { id: 'O2', text: 'Maximise sign-ups instead', author: 'pm-1', revises: 'O1' }, { now: NOW });
  assert.equal(one(db, `SELECT status FROM governance_objectives WHERE id='O2'`).status, 'proposed');
  for (const status of ['adopted', 'active', 'ratified']) {
    assert.deepEqual(await G.setObjectiveStatus(db, 'O2', status, { by: 'pm-1' }), { ok: false, reason: 'an objective revision is never adopted by its authoring agent' });
    assert.equal((await G.setObjectiveStatus(db, 'O2', status, { by: 'reviewer-2' })).ok, false, 'nor by another agent');
  }
  assert.equal(one(db, `SELECT status FROM governance_objectives WHERE id='O2'`).status, 'proposed');
  assert.deepEqual(await G.setObjectiveStatus(db, 'O2', 'adopted', { by: 'ratification', ratification_ref: 'card-17' }), { ok: true, status: 'ratified' });
  assert.equal(one(db, `SELECT ratified_by FROM governance_objectives WHERE id='O2'`).ratified_by, 'ratification:card-17');
});

test('US-07-R15 an adopted goal has a parent objective and an alignment sentence; a novel goal carries a probation deadline and is not dispatched', async () => {
  const db = await mk();
  await G.ratifyObjective(db, { id: 'O1', text: 'Keep the checkout service reliable and fast', by: 'principal' }, { now: NOW });
  const c = (id, text, extra = {}) => ({ id, text, definition_of_done: 'probe passes', falsifiability: 0.8, leverage: 0.8, novelty: 0.5, author: 'pm-1', ...extra });
  const r = await G.adoptGoals(db, [
    c('G1', 'Cut checkout service p95 latency below 300 ms', { alignment: 'A faster checkout serves the reliable and fast objective.', leverage: 0.9 }),
    c('G2', 'Publish a weekly digest of research papers'),
    c('G3', 'Tidy the folder names', { falsifiability: 0.2, leverage: 0.2, novelty: 0.2 }),
    c('G4', 'Make things better', { definition_of_done: '' }),
    c('G5', 'Reduce checkout service error rate under 1 percent', { alignment: 'Fewer errors serve reliability.' }),
    c('G6', 'Add a cache for the reliable checkout service', { alignment: 'Speed.' }),
  ], { now: NOW });
  assert.deepEqual(r.adopted.map(g => [g.id, g.kind, g.status, g.parent_objective]), [['G1', 'derived', 'adopted', 'O1'], ['G2', 'novel', 'probation', null], ['G5', 'derived', 'adopted', 'O1']]);
  assert.deepEqual(r.rejected.map(x => x.id).sort(), ['G3', 'G4', 'G6']);
  assert.match(r.rejected.find(x => x.id === 'G6').reason, /cycle limit of 3/);
  const g2 = one(db, `SELECT probation_until, dispatchable, parent_objective FROM governance_goals WHERE id='G2'`);
  assert.deepEqual({ ...g2 }, { probation_until: '2026-11-25 10:00:00', dispatchable: 0, parent_objective: null });
  for (const g of rows(db, `SELECT * FROM governance_goals WHERE status='adopted'`)) assert.ok(g.parent_objective && g.alignment.trim());
  assert.deepEqual(await G.drainGoalLedger(db, { now: NOW }), ['GOAL-G1', 'GOAL-G5'], 'adopted goals become work items; the novel goal does not');
  assert.deepEqual(await G.drainGoalLedger(db, { now: NOW }), []);
  // a reworded duplicate of a goal adopted in the last 30 days is rejected by containment even when Jaccard is low
  const again = await G.adoptGoals(db, [c('G7', 'Cut p95 latency of checkout service below 300 ms soon', { alignment: 'same' })], { now: NOW + DAY });
  assert.match(again.rejected[0].reason, /near-duplicate of G1/);
  db.raw.prepare(`UPDATE items SET status='done', disposition='done: observed' WHERE id='GOAL-G1'`).run();
  const retired = await G.retireGoals(db, { now: NOW + 15 * DAY });
  assert.deepEqual(retired, [{ id: 'G1', reason: 'done probe passed' }, { id: 'G2', reason: 'probation deadline passed without ratification' }]);
});

test('section 3.2 similarity: 10 tokens sharing 6 with a 14-token goal give Jaccard 0.33 and containment 0.6; the score is 0.4f + 0.4l + 0.2n', () => {
  const a = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g1', 'g2', 'g3', 'g4']);
  const b = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8']);
  const s = G.similarity(a, b);
  assert.ok(Math.abs(s.jaccard - 6 / 18) < 1e-9 && s.containment === 0.6);
  assert.ok(Math.abs(G.scoreGoal({ falsifiability: 1, leverage: 0.5, novelty: 0 }) - 0.6) < 1e-9);
});
