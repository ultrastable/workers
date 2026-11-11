// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tests for core/runner (US-SPEC-11, with US-SPEC-02, 05, 08, 09, 15 s5.3). Fake vcs and fake router; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as claims from '../claims/index.js';
import { createRouter } from '../router/router.js';
import { runTick } from '../src/tick.js';
import { parseDoerOutput, normalizePath, isProtected, DEFAULT_PROTECTED, runnerExtraSteps } from './index.js';
import { setup, until, runs, states, goodPatch, approve, reject } from './testkit.js';

const row = (db, sql, ...a) => db.raw.prepare(sql).get(...a);
const rows = (db, sql, ...a) => db.raw.prepare(sql).all(...a);
const done = db => runs(db).some(r => ['pr_opened', 'refused'].includes(r.state));

test('migration is idempotent and runner_ prefixed', () => {
  const { db } = setup();
  const sql = readFileSync(new URL('./migrations/0001_runner.sql', import.meta.url), 'utf8');
  db.raw.exec(sql); db.raw.exec(sql);
  const names = rows(db, `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'runner_%'`).map(r => r.name).sort();
  assert.deepEqual(names, ['runner_events', 'runner_item_context', 'runner_runs']);
});

test('happy path: planned to a DRAFT pull request, with real check results, never merged', async () => {
  const { db, runner, vcs, router } = setup();
  await until(runner, db, () => done(db));
  const r = runs(db)[0];
  assert.equal(r.state, 'pr_opened');
  assert.deepEqual(states(db), ['planned', 'patched', 'checks_passed', 'reviewing', 'approved', 'pr_opened']);
  assert.equal(vcs.commits.length, 1);
  assert.equal(vcs.prs.length, 1);
  const pr = vcs.prs[0];
  assert.match(pr.body, /unit-tests: success/);
  assert.match(pr.body, /US-SPEC-11/);
  assert.match(pr.body, /never merges/);
  assert.equal(typeof vcs.merge, 'undefined');
  assert.equal(r.pr_number, 101);
  assert.equal(row(db, `SELECT result FROM outcomes WHERE item_id = ?`, r.item_id).result, 'verified');
  assert.equal(row(db, `SELECT status FROM items WHERE id = ?`, r.item_id).status, 'blocked'); // waits for a person to merge
  assert.equal(row(db, `SELECT COUNT(*) n FROM claims_lock WHERE released_at IS NULL`).n, 0);
  // minimal context: only the named target, the test and the spec text, never the whole repository
  const user = JSON.parse(router.requests[0].messages[1].content);
  assert.deepEqual(user.files.map(f => f.path), ['core/example/widget.js']);
  assert.equal(user.test.path, 'core/example/widget.test.js');
  assert.equal(user.failing_test, 'widget renders');
  assert.equal(router.requests[0].rung, 'medium');
});

test('doer output on a protected path is refused: decision card, nothing pushed', async () => {
  for (const p of ['LICENSE', 'autonomy/policy.json', '.github/workflows/ci.yml', 'core/test/no-qnfo.test.js', 'SCOPE.md', 'self/IDEA.md', 'COMMERCIAL-TERMS.md']) {
    const { db, runner, vcs } = setup({ script: { doer: [goodPatch(p)] } });
    await until(runner, db, () => done(db));
    const r = runs(db)[0];
    assert.equal(r.state, 'refused', p); assert.equal(r.reason, 'protected_path');
    assert.equal(vcs.commits.length, 0); assert.equal(vcs.branches.length, 0);
    assert.equal(rows(db, `SELECT * FROM gate_cards WHERE id LIKE 'runner-%protected_path'`).length, 1);
    assert.equal(row(db, `SELECT status FROM items WHERE id='US-SPEC-11-1'`).status, 'blocked');
  }
});

test('an item whose target is protected never reaches the doer; config can add protected paths but not remove them', async () => {
  const { db, runner, router } = setup({ files: { LICENSE: 'x' } });
  db.raw.prepare(`UPDATE items SET done_check = 'target: LICENSE'`).run();
  await runner.step();
  assert.equal(runs(db)[0].reason, 'protected_path'); assert.equal(router.requests.length, 0);
  const s = await setup({ config: { protected_paths: ['docs/secret/'] } }).runner.status();
  for (const p of DEFAULT_PROTECTED) assert.ok(s.protected_paths.includes(p));
  assert.ok(s.protected_paths.includes('docs/secret/'));
  assert.equal(isProtected('docs/secret/a.md', s.protected_paths), true);
  assert.equal(isProtected('core/runner/index.js', s.protected_paths), false);
  assert.equal(isProtected('Self/x', s.protected_paths), true); // case-insensitive
});

test('path traversal and absolute paths are invalid doer output', () => {
  for (const p of ['../x', '/etc/passwd', 'a/../b', 'a\\b', 'C:/x', '', 'a//b']) assert.equal(normalizePath(p), null, p);
  const bad = parseDoerOutput(JSON.stringify({ summary: 's', files: [{ path: '../x', content: 'c' }] }), { max_files: 5, max_file_bytes: 100 });
  assert.match(bad.error, /invalid path/);
});

test('checks fail, then rework, then success; prediction scored once from the first result', async () => {
  const { db, runner, vcs, router } = setup({
    checksScript: ['failure', 'success'],
    script: { doer: [goodPatch('core/example/widget.js', 'v1'), goodPatch('core/example/widget.js', 'v2')], reviewer: [approve] },
  });
  await until(runner, db, () => done(db));
  const r = runs(db)[0];
  assert.equal(r.state, 'pr_opened'); assert.equal(r.rework_count, 1);
  assert.equal(vcs.commits.length, 2); assert.equal(vcs.commits[0].branch, vcs.commits[1].branch); // same branch
  assert.deepEqual(states(db), ['planned', 'patched', 'checks_failed', 'rework', 'patched', 'checks_passed', 'reviewing', 'approved', 'pr_opened']);
  const second = JSON.parse(router.requests[1].messages[1].content);
  assert.match(second.rework.feedback, /assertion failed in widget.test/);
  const p = row(db, `SELECT * FROM predictions WHERE id = ?`, r.prediction_id);
  assert.equal(p.verdict, 'miss'); assert.equal(p.observed, 0); // predicted pass, first checks failed
  assert.deepEqual(router.predictionSeenBeforeDoer, [true, true]);
});

test('prediction hit when checks pass first time; written before the doer call', async () => {
  const { db, runner, router } = setup();
  await until(runner, db, () => done(db));
  const p = row(db, `SELECT * FROM predictions`);
  assert.equal(p.metric, 'runner_checks_pass'); assert.equal(p.verdict, 'hit'); assert.equal(p.observed, 1);
  assert.deepEqual(router.predictionSeenBeforeDoer, [true]);
});

test('rework limit makes a decision card and stops the run', async () => {
  const { db, runner, vcs } = setup({ checksScript: ['failure'], config: { max_rework: 2 }, script: { doer: [goodPatch()], reviewer: [approve] } });
  await until(runner, db, () => done(db));
  const r = runs(db)[0];
  assert.equal(r.state, 'refused'); assert.equal(r.reason, 'rework_limit'); assert.equal(r.rework_count, 2);
  assert.equal(vcs.commits.length, 3); assert.equal(vcs.prs.length, 0);
  assert.equal(rows(db, `SELECT * FROM gate_cards WHERE id = ?`, `runner-${r.id}-rework_limit`).length, 1);
  assert.equal(row(db, `SELECT result FROM outcomes`).result, 'failed');
  assert.equal(row(db, `SELECT COUNT(*) n FROM claims_lock WHERE released_at IS NULL`).n, 0);
  assert.equal(row(db, `SELECT verdict FROM predictions`).verdict, 'miss');
});

test('reviewer reject goes to rework; repeated rejects hit the limit and record hidden_failure', async () => {
  const one = setup({ script: { doer: [goodPatch()], reviewer: [reject, approve] } });
  await until(one.runner, one.db, () => done(one.db));
  assert.equal(runs(one.db)[0].state, 'pr_opened'); assert.equal(runs(one.db)[0].rework_count, 1);
  assert.match(JSON.parse(one.router.requests[2].messages[1].content).rework.feedback, /reviewer rejected: edge case/);
  const all = setup({ script: { doer: [goodPatch()], reviewer: [reject] } });
  await until(all.runner, all.db, () => done(all.db));
  assert.equal(runs(all.db)[0].reason, 'rework_limit');
  assert.equal(row(all.db, `SELECT result FROM outcomes`).result, 'hidden_failure'); // checks were green, review caught it
  assert.equal(all.vcs.prs.length, 0);
});

test('budget: a router hard cap refuses the run with a decision card', async () => {
  const { db, runner } = setup({ script: { doer: [{ refusal: 'hard_cap' }] } });
  await until(runner, db, () => done(db));
  assert.equal(runs(db)[0].reason, 'budget');
  assert.equal(rows(db, `SELECT * FROM gate_cards WHERE id LIKE 'runner-%-budget'`).length, 1);
});

test('budget: the per-item spend cap stops the item before the next paid call', async () => {
  const { db, runner, router } = setup({ config: { max_usd_per_item: 1 }, script: { doer: [{ text: goodPatch(), cost: 1.2 }], reviewer: [approve] } });
  await until(runner, db, () => done(db));
  assert.equal(runs(db)[0].reason, 'item_cost_cap');
  assert.equal(router.requests.length, 1); // no reviewer call was made
  assert.equal(rows(db, `SELECT * FROM gate_cards WHERE id LIKE '%item_cost_cap'`).length, 1);
});

test('budget: the per-item call cap stops a loop', async () => {
  const { db, runner } = setup({ config: { max_calls_per_item: 2, max_rework: 5 }, checksScript: ['failure'] });
  await until(runner, db, () => done(db));
  assert.equal(runs(db)[0].reason, 'item_call_cap');
});

test('kill switch: no new run is selected and an in-flight run is refused', async () => {
  const a = setup(); a.router.killed = true;
  await a.runner.step();
  assert.equal(runs(a.db).length, 0);
  const c2 = setup(); await c2.runner.step(); c2.router.killed = true;
  await until(c2.runner, c2.db, () => done(c2.db));
  assert.equal(runs(c2.db)[0].reason, 'kill_switch');
  assert.equal(c2.vcs.commits.length, 0);
});

test('invalid doer JSON is retried, then refused after the limit', async () => {
  const ok = setup({ script: { doer: ['this is not json', '{"summary":"x","files":"nope"}', goodPatch()], reviewer: [approve] }, config: { max_doer_retries: 3 } });
  await until(ok.runner, ok.db, () => done(ok.db));
  assert.equal(runs(ok.db)[0].state, 'pr_opened');
  const bad = setup({ script: { doer: ['```json\n{broken\n```'] } });
  await until(bad.runner, bad.db, () => done(bad.db));
  assert.equal(runs(bad.db)[0].reason, 'invalid_output'); assert.equal(bad.vcs.commits.length, 0);
  assert.equal(row(bad.db, `SELECT result FROM outcomes`).result, 'failed');
  assert.ok(parseDoerOutput('```json\n' + goodPatch() + '\n```', { max_files: 5, max_file_bytes: 1000 }).files);
  assert.match(parseDoerOutput('{"summary":"s","files":[],"x":1}', { max_files: 5, max_file_bytes: 10 }).error, /unexpected keys/);
});

test('the reviewer is a different family than the doer (real router, fake fetch)', async () => {
  const config = JSON.parse(readFileSync(new URL('../router/example-config.json', import.meta.url), 'utf8'));
  const env = { PROVIDER_A_API_KEY: 'sk-test-aaaa1111', PROVIDER_B_API_KEY: 'sk-test-bbbb2222' };
  const text = { doer: goodPatch(), reviewer: approve };
  const build = (envx) => {
    const base = setup();
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const kind = /code reviewer/.test(JSON.stringify(body.messages || []) + String(body.system || '')) ? 'reviewer' : 'doer';
      const payload = url.includes('provider-a')
        ? { choices: [{ message: { content: text[kind] } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }
        : { content: [{ type: 'text', text: text[kind] }], usage: { input_tokens: 100, output_tokens: 50 } };
      return new Response(JSON.stringify(payload), { status: 200 });
    };
    const router = createRouter({ db: base.db, fetch, now: base.now, config, env: envx });
    return { ...base, router, runner: base.mk({ router }) };
  };
  const both = build(env);
  await until(both.runner, both.db, () => done(both.db));
  assert.equal(runs(both.db)[0].state, 'pr_opened');
  const fam = rows(both.db, `SELECT kind, family FROM router_calls WHERE outcome='ok' ORDER BY id`);
  assert.deepEqual(fam.map(f => f.kind), ['doer', 'reviewer']);
  assert.notEqual(fam[0].family, fam[1].family);
  // with only one family configured there is no independent reviewer: refuse, never self-review
  const one = build({ PROVIDER_A_API_KEY: env.PROVIDER_A_API_KEY });
  await until(one.runner, one.db, () => done(one.db));
  assert.equal(runs(one.db)[0].reason, 'no_distinct_family');
  assert.equal(one.vcs.prs.length, 0);
});

test('the reviewer request names kind reviewer and the same item as the doer', async () => {
  const { db, runner, router } = setup();
  await until(runner, db, () => done(db));
  const [d, r] = router.requests;
  assert.equal(d.kind, 'doer'); assert.equal(r.kind, 'reviewer'); assert.equal(d.item_id, r.item_id);
  const user = JSON.parse(r.messages[1].content);
  assert.match(user.diff, /widget v2/); assert.equal(user.checks[0].name, 'unit-tests'); assert.match(user.done_check, /US-SPEC-11/);
});

test('a run resumes after a restart: state is in the database, not memory', async () => {
  const { db, runner, mk, vcs, router } = setup({ checksScript: ['pending', 'pending', 'success'] });
  await runner.step(); await runner.step(); await runner.step();
  assert.equal(runs(db)[0].state, 'checks_pending');
  const fresh = mk(); // a brand new runner, as after a process restart
  await until(fresh, db, () => done(db));
  assert.equal(runs(db)[0].state, 'pr_opened');
  assert.equal(router.requests.filter(r => r.kind === 'doer').length, 1);
  assert.equal(vcs.commits.length, 1);
});

test('max work in progress, enabled flag and staff-only selection', async () => {
  const two = setup({ extraItems: ['US-SPEC-11-2'], checksScript: ['pending'] });
  for (let i = 0; i < 4; i++) await two.runner.step();
  assert.equal(runs(two.db).length, 1);
  assert.equal((await two.runner.status()).wip, 1);
  const off = setup({ config: { enabled: false } });
  await off.runner.step();
  assert.equal(runs(off.db).length, 0);
  const other = setup(); other.db.raw.prepare(`UPDATE items SET owner_role='operations'`).run();
  await other.runner.step();
  assert.equal(runs(other.db).length, 0);
  assert.equal((await off.runner.startRun('US-SPEC-11-1')).ok, true); // an explicit start still works
});

test('an item already claimed by someone else is not taken; priority order is respected', async () => {
  const { db, runner } = setup({ extraItems: ['US-SPEC-11-2'] });
  db.raw.prepare(`UPDATE items SET priority = 50 WHERE id = 'US-SPEC-11-1'`).run();
  await runner.step();
  assert.equal(runs(db)[0].item_id, 'US-SPEC-11-2');
  const held = setup();
  await claims.acquire({ db: held.db, now: held.now, config: {} }, { item_id: 'US-SPEC-11-1', holder: 'person', intent: 'doing it myself' });
  await held.runner.step();
  assert.equal(runs(held.db).length, 0);
});

test('an item with no target file becomes a decision card, not a guess', async () => {
  const { db, runner, router } = setup();
  db.raw.prepare(`UPDATE items SET done_check = 'make it better'`).run();
  await runner.step();
  assert.equal(runs(db)[0].reason, 'no_target'); assert.equal(router.requests.length, 0);
  assert.equal(rows(db, `SELECT * FROM gate_cards WHERE id LIKE '%no_target'`).length, 1);
});

test('runner_item_context supplies spec text and targets', async () => {
  const { db, runner, router } = setup();
  db.raw.prepare(`UPDATE items SET done_check = 'plain'`).run();
  db.raw.prepare(`INSERT INTO runner_item_context (item_id, spec_ref, spec_text, targets, test_path) VALUES ('US-SPEC-11-1','US-SPEC-11 R05','The runner MUST do X.','["core/example/widget.js"]','core/example/widget.test.js')`).run();
  await runner.step(); await runner.step();
  const user = JSON.parse(router.requests[0].messages[1].content);
  assert.equal(user.spec_text, 'The runner MUST do X.'); assert.equal(user.spec_reference, 'US-SPEC-11 R05');
});

test('transient provider failure retries; repeated vcs errors stop the run', async () => {
  const t = setup({ script: { doer: [{ refusal: 'all_providers_failed' }, goodPatch()], reviewer: [approve] } });
  await until(t.runner, t.db, () => done(t.db));
  assert.equal(runs(t.db)[0].state, 'pr_opened');
  const e = setup({ config: { max_errors: 3 } });
  e.vcs.createBranch = async () => { throw new Error('boom'); };
  await until(e.runner, e.db, () => done(e.db));
  assert.equal(runs(e.db)[0].reason, 'repeated_errors');
});

test('status reports counts, spend and protected paths', async () => {
  const { db, runner } = setup();
  await until(runner, db, () => done(db));
  const s = await runner.status();
  assert.equal(s.by_state.pr_opened, 1); assert.equal(s.wip, 0); assert.ok(s.total_cost_usd > 0); assert.equal(s.enabled, true);
});

test('plugs into runTick through extraSteps next to the seed steps', async () => {
  const policy = JSON.parse(readFileSync(new URL('../../autonomy/policy.json', import.meta.url), 'utf8'));
  const config = { org_slug: 't', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy };
  const { db, runner, clock } = setup();
  let result;
  for (let i = 0; i < 12 && !done(db); i++) { clock.t += 60000; result = await runTick(db, { config, now: clock.t, extraSteps: runnerExtraSteps(runner) }); }
  assert.equal(runs(db)[0].state, 'pr_opened');
  assert.deepEqual(result.errors, []);
  assert.equal(result.total, 8);
});

test('only a keyless small model configured: the item becomes a decision card, no PR', async () => {
  const { db, vcs, router, runner } = setup();
  router.route = async () => ({ ok: false, refusal: 'role_not_allowed' });
  await runner.step();
  const card = db.raw.prepare(`SELECT what FROM gate_cards WHERE id = 'runner-US-SPEC-11-1-stronger-model'`).get();
  assert.match(card.what, /stronger model is needed for code changes/);
  assert.equal(db.raw.prepare(`SELECT status FROM items WHERE id = 'US-SPEC-11-1'`).get().status, 'blocked');
  assert.equal(vcs.prs.length, 0); assert.equal(runs(db).length, 0);
});
