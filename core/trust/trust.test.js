// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { runTick } from '../src/tick.js';
import * as T from './index.js';

const MIG = fileURLToPath(T.MIGRATIONS_DIR);
const POLICY = JSON.parse(readFileSync(new URL('../../autonomy/policy.json', import.meta.url), 'utf8'));
const NOW = Date.UTC(2026, 10, 11, 10, 0, 0);
const DAY = 86400e3;
const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const mk = () => makeDb([MIG]);
const one = (db, sql, ...a) => db.raw.prepare(sql).get(...a);
const rows = (db, sql, ...a) => db.raw.prepare(sql).all(...a);
const clone = (o) => JSON.parse(JSON.stringify(o));
function outcomes(db, surface, action, result, n, { agent = null, at = iso(NOW) } = {}) {
  const st = db.raw.prepare(`INSERT INTO outcomes (agent, surface, action_class, result, at) VALUES (?,?,?,?,?)`);
  for (let i = 0; i < n; i++) st.run(agent, surface, action, result, at);
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('migration is idempotent and tables are trust_ prefixed', () => {
  const db = mk();
  const sql = readFileSync(MIG + '0001_trust.sql', 'utf8');
  db.raw.exec(sql); db.raw.exec(sql);
  for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) assert.match(m[1], /^trust_/);
});

test('US-06-T01, US-06-R02, US-06-R03 reliability with no outcomes is the baseline; the formula takes its prior from the policy', () => {
  const s = T.settings(POLICY);
  assert.equal(T.reliability(0, 0, s), 0.5);
  assert.ok(near(T.reliability(10, 10, s), 11 / 12) && near(T.reliability(9, 10, s), 10 / 12) && near(T.reliability(8, 10, s), 0.75) && near(T.reliability(3, 8, s), 0.4));
  // the other stated prior of section 3 (b = 0.5, w = 10): (ok + 5) / (ok + fail + 10)
  const wide = { baseline: 0.5, prior_weight: 10 };
  assert.ok(near(T.reliability(30, 65, wide), 35 / 75) && near(T.reliability(59, 70, wide), 0.8));
  const unstated = clone(POLICY); delete unstated.trust.prior_weight;
  assert.throws(() => T.settings(unstated), /must state baseline, prior_weight and formula/);
});

test('US-06-R01, US-06-T02, US-06-R05 12 verified outcomes on a propose-ceiling surface open a LADDER-*-assisted item; the rung is not changed', async () => {
  const db = mk();
  outcomes(db, 'outreach', 'draft', 'verified', 12);
  const r = await T.recompute(db, { policy: POLICY, now: NOW });
  assert.deepEqual(r.map(x => [x.surface, x.rung, x.indicated, x.item]), [['outreach', 'observed', 'assisted', 'LADDER-outreach-draft-assisted']]);
  const item = one(db, `SELECT kind, owner_role, priority, closing_probe FROM items WHERE id='LADDER-outreach-draft-assisted'`);
  assert.deepEqual({ ...item }, { kind: 'ladder', owner_role: 'operations', priority: 20, closing_probe: 'trust_ledger rung = assisted' });
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM trust_ledger`).n, 0, 'recompute never writes a rung');
  const s = one(db, `SELECT ok, n, reliability, score, indicated_rung FROM trust_scores`);
  assert.ok(near(s.reliability, 13 / 14) && s.indicated_rung === 'assisted');
  await T.recompute(db, { policy: POLICY, now: NOW });
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM items`).n, 1, 'one item per crossing');
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM trust_transitions`).n, 1);
});

test('US-06-R04 a pair at its ceiling is never proposed above it, however reliable', async () => {
  const db = mk();
  outcomes(db, 'outreach', 'draft', 'verified', 40);
  db.raw.prepare(`INSERT INTO trust_ledger (surface, action_class, rung, reliability) VALUES ('outreach','draft','assisted',0.9)`).run();
  const r = await T.recompute(db, { policy: POLICY, now: NOW });
  assert.deepEqual([r[0].rung, r[0].indicated, r[0].item], ['assisted', 'assisted', undefined]);
  assert.equal(T.ceilingFor(POLICY, 'outreach'), 'assisted'); assert.equal(T.ceilingFor(POLICY, 'repo'), 'self-extending'); assert.equal(T.ceilingFor(POLICY, 'unknown-surface'), 'observed');
});

test('US-06-T03, US-06-R07 one hidden_failure on a pair above observed opens a demotion item at priority 0; outside the stated window it no longer demotes', async () => {
  const db = mk();
  outcomes(db, 'repo', 'open_pr', 'verified', 20);
  outcomes(db, 'repo', 'open_pr', 'hidden_failure', 1);
  const r = await T.recompute(db, { policy: POLICY, now: NOW });
  assert.equal(r[0].item, 'LADDER-repo-open_pr-assisted');
  assert.equal(one(db, `SELECT priority FROM items WHERE id=?`, r[0].item).priority, 0);
  const ev = JSON.parse(one(db, `SELECT evidence FROM trust_transitions`).evidence);
  assert.deepEqual([ev.severe_in_window, ev.severe_window_days, ev.outcomes], [1, 14, 21]);
  // the same history 20 days later: the severe outcome is outside the 14-day window
  const later = mk();
  outcomes(later, 'repo', 'open_pr', 'verified', 20, { at: iso(NOW - 20 * DAY) });
  outcomes(later, 'repo', 'open_pr', 'hidden_failure', 1, { at: iso(NOW - 20 * DAY) });
  const w = await T.recompute(later, { policy: POLICY, now: NOW, config: { decay_per_unit: 0 } });
  assert.deepEqual([w[0].severe, w[0].indicated], [0, 'autonomous']);
  // all time, stated explicitly, keeps demoting
  const allTime = await T.recompute(mkWith(later), { policy: POLICY, now: NOW, config: { severe_window_days: null, decay_per_unit: 0 } });
  assert.equal(allTime[0].indicated, 'assisted');
});
function mkWith(src) {
  const db = mk();
  for (const o of rows(src, `SELECT agent, surface, action_class, result, at FROM outcomes`)) db.raw.prepare(`INSERT INTO outcomes (agent, surface, action_class, result, at) VALUES (?,?,?,?,?)`).run(o.agent, o.surface, o.action_class, o.result, o.at);
  return db;
}

test('US-06-R06, US-06-R17 a rung change is applied only by an agent different from the opener; every transition is recorded with evidence', async () => {
  const db = mk();
  outcomes(db, 'outreach', 'draft', 'verified', 12);
  const [{ item }] = await T.recompute(db, { policy: POLICY, now: NOW, config: { opened_by: 'ops-1' } });
  assert.deepEqual(await T.applyRungChange(db, { item_id: item, merged_by: 'ops-1', policy: POLICY, now: NOW }), { applied: false, reason: 'merged by the agent that opened the item' });
  assert.equal((await T.applyRungChange(db, { item_id: item, merged_by: '', policy: POLICY, now: NOW })).applied, false);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM trust_ledger`).n, 0);
  const ok = await T.applyRungChange(db, { item_id: item, merged_by: 'reviewer-2', policy: POLICY, now: NOW });
  assert.deepEqual([ok.applied, ok.rung], [true, 'assisted']);
  assert.equal(one(db, `SELECT rung FROM trust_ledger WHERE surface='outreach' AND action_class='draft'`).rung, 'assisted');
  const log = rows(db, `SELECT status, opened_by, merged_by, evidence FROM trust_transitions ORDER BY id`);
  assert.deepEqual(log.map(l => [l.status, l.merged_by]), [['proposed', null], ['refused', 'ops-1'], ['refused', ''], ['applied', 'reviewer-2']]);
  for (const l of log) assert.ok(JSON.parse(l.evidence).prior.prior_weight === 2 && l.opened_by === 'ops-1');
  assert.equal((await T.applyRungChange(db, { item_id: item, merged_by: 'reviewer-3', policy: POLICY, now: NOW })).reason, 'already applied');
  // a proposal above the ceiling cannot be applied even by a different agent
  db.raw.prepare(`INSERT INTO trust_transitions (surface, action_class, executor, from_rung, to_rung, direction, status, evidence, item_id, opened_by, at) VALUES ('money','estimate_cost','','observed','delegated','promote','proposed','{}','X','ops-1','t')`).run();
  assert.match((await T.applyRungChange(db, { item_id: 'X', merged_by: 'reviewer-2', policy: POLICY, now: NOW })).reason, /above the surface ceiling assisted/);
});

test('the module agrees with the seed tick: the tick opens the ladder item, recompute attaches its transition, the merge closes it by the seed probe', async () => {
  const db = mk();
  outcomes(db, 'outreach', 'draft', 'verified', 12);
  const config = { policy: POLICY, claim_ttl_minutes: 60, max_wip_per_role: 2, plus_share: 0.2 };
  await runTick(db, { config, now: NOW });
  assert.equal(one(db, `SELECT rung FROM trust_ledger`).rung, 'observed');
  const [r] = await T.recompute(db, { policy: POLICY, now: NOW });
  assert.equal(r.item, 'LADDER-outreach-draft-assisted');
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM items WHERE kind='ladder'`).n, 1, 'no duplicate item');
  await T.applyRungChange(db, { item_id: r.item, merged_by: 'reviewer-2', policy: POLICY, now: NOW });
  assert.equal(one(db, `SELECT rung FROM trust_ledger`).rung, 'assisted');
});

test('event weights move the score by the stated amounts; an unknown event is refused', async () => {
  const db = mk();
  outcomes(db, 'repo', 'open_pr', 'verified', 8); outcomes(db, 'repo', 'open_pr', 'failed', 2);
  const base = (await T.recompute(db, { policy: POLICY, now: NOW }))[0].score;
  assert.ok(near(base, 0.75));
  await T.recordEvent(db, { surface: 'repo', action_class: 'open_pr', event: 'hidden_failure' }, { now: NOW });
  await T.recordEvent(db, { surface: 'repo', action_class: 'open_pr', event: 'friction_closed' }, { now: NOW });
  await T.recordEvent(db, { surface: 'repo', action_class: 'open_pr', event: 'verified_autonomous_action' }, { now: NOW });
  const r = (await T.recompute(db, { policy: POLICY, now: NOW }))[0];
  assert.ok(near(r.score, 0.75 - 0.30 + 0.10 + 0.02));
  assert.ok(near(r.reliability, 0.75), 'the beta-prior reliability itself is untouched');
  assert.equal(r.indicated, 'assisted', 'a score under 0.6 indicates a demotion from delegated');
  await assert.rejects(T.recordEvent(db, { surface: 'repo', action_class: 'open_pr', event: 'made_up' }), /unknown trust event/);
  assert.deepEqual(Object.values(T.EVENT_WEIGHTS), [0.02, 0.03, 0.10, -0.20, -0.30, -0.05, -0.10]);
  // an event on a pair with no outcomes starts from the baseline
  await T.recordEvent(db, { surface: 'dns', action_class: 'read', event: 'unnecessary_question' }, { now: NOW });
  assert.ok(near((await T.recompute(db, { policy: POLICY, now: NOW })).find(x => x.surface === 'dns').score, 0.45));
});

test('decay moves an unexercised score toward the prior by 0.01 per idle day or per idle tick, never across it', async () => {
  const db = mk();
  outcomes(db, 'repo', 'open_pr', 'verified', 10, { at: iso(NOW - 10 * DAY) }); // 11/12 = 0.9167
  outcomes(db, 'dns', 'read', 'failed', 8, { at: iso(NOW - 10 * DAY) });        // 1/10 = 0.1
  const byDay = await T.recompute(db, { policy: POLICY, now: NOW });
  assert.ok(near(byDay.find(x => x.surface === 'repo').score, 11 / 12 - 0.10));
  assert.ok(near(byDay.find(x => x.surface === 'dns').score, 0.1 + 0.10));
  const far = await T.recompute(db, { policy: POLICY, now: NOW + 990 * DAY });
  assert.deepEqual(far.map(x => x.score), [0.5, 0.5]);
  for (let i = 0; i < 3; i++) db.raw.prepare(`INSERT INTO tick_runs (started_at, steps_total) VALUES (?, 8)`).run(iso(NOW - (i + 1) * 3600e3));
  const byTick = await T.recompute(db, { policy: POLICY, now: NOW, config: { decay_unit: 'tick' } });
  assert.ok(near(byTick.find(x => x.surface === 'repo').score, 11 / 12 - 0.03));
  assert.equal(one(db, `SELECT idle_units FROM trust_scores WHERE surface='repo'`).idle_units, 3);
  assert.equal(T.decayToward(0.52, 0.5, 0.1), 0.5); assert.equal(T.decayToward(0.3, 0.5, 0.05), 0.35);
});

test('the banded alternative maps a score to its rung and moves one rung at a time, inside the ceiling', async () => {
  const s = T.settings(POLICY, { mode: 'banded' });
  assert.deepEqual([0.1, 0.3, 0.55, 0.65, 0.75, 0.85, 0.95].map(x => T.rungForScore(x, s)), POLICY.ladder.rungs);
  const db = mk();
  outcomes(db, 'repo', 'open_pr', 'verified', 30); // 31/32 = 0.97: band self-extending, currently delegated
  outcomes(db, 'outreach', 'draft', 'verified', 30);
  const r = await T.recompute(db, { policy: POLICY, now: NOW, config: { mode: 'banded' } });
  assert.equal(r.find(x => x.surface === 'repo').indicated, 'autonomous');
  assert.equal(r.find(x => x.surface === 'outreach').indicated, 'assisted');
});

test('US-06-R19 per-executor trust: the effective rung is the minimum of the executor rung and the pair rung', async () => {
  const db = mk();
  outcomes(db, 'repo', 'open_pr', 'verified', 12, { agent: 'doer-good' });
  outcomes(db, 'repo', 'open_pr', 'verified', 2, { agent: 'doer-bad' });
  outcomes(db, 'repo', 'open_pr', 'failed', 6, { agent: 'doer-bad' });
  const r = await T.recompute(db, { policy: POLICY, now: NOW });
  const bad = r.find(x => x.executor === 'doer-bad');
  assert.ok(near(bad.score, 0.3)); assert.equal(bad.item, 'LADDER-repo-open_pr-assisted@doer-bad');
  assert.equal(r.find(x => x.executor === 'doer-good').item, undefined, 'an executor is not promoted above its pair');
  assert.equal(r.find(x => x.executor === '').indicated, 'delegated');
  await T.applyRungChange(db, { item_id: bad.item, merged_by: 'reviewer-2', policy: POLICY, now: NOW });
  const eff = await T.effectiveRung(db, { surface: 'repo', action_class: 'open_pr', executor: 'doer-bad', policy: POLICY });
  assert.deepEqual([eff.pair_rung, eff.executor_rung, eff.rung], ['delegated', 'assisted', 'assisted']);
  assert.equal((await T.effectiveRung(db, { surface: 'repo', action_class: 'open_pr', executor: 'doer-good', policy: POLICY })).rung, 'delegated');
  // the executor's closing probe is a query the tick can read
  assert.equal(Object.values(one(db, one(db, `SELECT closing_probe FROM items WHERE id=?`, bad.item).closing_probe))[0], 1);
  // an executor rung above the pair rung is still bounded by the pair, and the pair by the ceiling
  db.raw.prepare(`INSERT INTO trust_executor_rungs VALUES ('outreach','draft','x','self-extending','t')`).run();
  db.raw.prepare(`INSERT INTO trust_ledger (surface, action_class, rung, reliability) VALUES ('outreach','draft','autonomous',0.9)`).run();
  assert.equal((await T.effectiveRung(db, { surface: 'outreach', action_class: 'draft', executor: 'x', policy: POLICY })).rung, 'assisted');
});

test('US-06-R18 the queue multiplier is the pair score, or the baseline for a pair never scored', async () => {
  const db = mk();
  outcomes(db, 'repo', 'open_pr', 'verified', 8); outcomes(db, 'repo', 'open_pr', 'failed', 2);
  await T.recompute(db, { policy: POLICY, now: NOW });
  assert.ok(near(await T.queueMultiplier(db, { surface: 'repo', action_class: 'open_pr', policy: POLICY }), 0.75));
  assert.equal(await T.queueMultiplier(db, { surface: 'dns', action_class: 'read', policy: POLICY }), 0.5);
});

test('US-06-R11, US-06-T04, US-06-R12 the validator passes the shipped policy and returns a problem for each fault of section 3.3; an invalid policy blocks', () => {
  assert.deepEqual(T.validatePolicy(POLICY), []);
  const bad = (fn) => { const p = clone(POLICY); fn(p); return T.validatePolicy(p); };
  assert.match(bad(p => { p.surfaces.money.start_rung = 'delegated'; })[0], /money: start rung delegated is above its ceiling assisted/);
  assert.match(bad(p => { p.surfaces.repo.start_rung = 'godlike'; })[0], /not on the ladder/);
  assert.match(bad(p => { p.surfaces.repo.max_permission = 'all'; })[0], /max_permission must be/);
  assert.match(bad(p => { p.surfaces.money.actions.spend.reversible_path = 'refund'; })[0], /would not be gated/);
  assert.match(bad(p => { delete p.surfaces.repo.actions.force_push_default_branch.denied; })[0], /needs a reversible path or denied/);
  for (const s of ['money', 'legal', 'outreach', 'secrets']) assert.ok(bad(p => { p.surfaces[s].max_permission = 'execute'; }).some(x => x === `${s}: ceiling must be below execute`));
  assert.deepEqual(bad(p => { p.standing_limits.limits = ['another session\'s live claim']; }),
    ['standing limits: no entry names the harness', 'standing limits: no entry names the secret lock', "standing limits: no entry names the principal's override"]);
  const invalid = clone(POLICY); invalid.surfaces.money.start_rung = 'delegated';
  assert.throws(() => T.assertPolicy(invalid), /invalid policy: money: start rung delegated is above its ceiling assisted/);
  assert.equal(T.assertPolicy(POLICY), POLICY);
});

test('mirror rule: a harness_deny pattern missing from the harness deny list is reported', () => {
  const allPatterns = Object.values(POLICY.surfaces).flatMap(s => Object.values(s.actions).flatMap(a => a.harness_deny || []));
  assert.ok(allPatterns.length > 0);
  assert.deepEqual(T.mirrorProblems(POLICY, allPatterns), []);
  assert.deepEqual(T.mirrorProblems(POLICY, allPatterns.filter(p => p !== 'Bash(git push -f:*)')), ['repo.force_push_default_branch: Bash(git push -f:*)']);
});

test('US-06-R08 an irreversible, identity-bound action is not executable at any rung: it produces one gate card and nothing else stops', async () => {
  const db = mk();
  db.raw.prepare(`INSERT INTO trust_ledger (surface, action_class, rung, reliability) VALUES ('money','spend','self-extending',1.0)`).run();
  const a = { surface: 'money', action_class: 'spend', target: 'invoice-9', executor: 'ops-1', card: { closing_probe: 'item_done:PAY-9', prepared_by_fleet: 'invoice checked, payment drafted', identity_bound_line: 'only the principal can pay from their account' } };
  const r = await T.authorize(db, a, { policy: POLICY, now: NOW });
  assert.deepEqual([r.allowed, r.refused, r.gate_card], [false, 'interrupt_gate', 'GATE-money-spend-invoice-9']);
  const card = one(db, `SELECT * FROM gate_cards WHERE id=?`, r.gate_card);
  assert.deepEqual([card.status, card.closing_probe, card.default_in_effect], ['open', 'item_done:PAY-9', 'the action is not taken; all other work continues']);
  await T.authorize(db, a, { policy: POLICY, now: NOW });
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM gate_cards`).n, 1, 'one card');
  assert.equal((await T.authorize(db, { surface: 'money', action_class: 'estimate_cost', executor: 'ops-1' }, { policy: POLICY, now: NOW })).allowed, true, 'other work continues');
  // an override cannot push a gated action through
  assert.equal((await T.authorize(db, { ...a, override: 'allow' }, { policy: POLICY, now: NOW })).refused, 'interrupt_gate');
});

test('US-06-R14 reversible forms are attempted and recorded before an action is classed irreversible; a found form proceeds without a card', async () => {
  const db = mk();
  const forms = [{ form: 'backup', attempt: async () => ({ ok: false, detail: 'no export available' }) }, { form: 'draft', attempt: async () => ({ ok: true, path: 'saved as a draft, not sent' }) }, { form: 'canary', attempt: async () => { throw new Error('must not run'); } }];
  const r = await T.authorize(db, { surface: 'outreach', action_class: 'send_as_owner', target: 'list-1', reversible_forms: forms }, { policy: POLICY, now: NOW });
  assert.deepEqual([r.allowed, r.via], [true, 'engineered: draft (saved as a draft, not sent)']);
  assert.deepEqual(rows(db, `SELECT form, ok FROM trust_reversibility_attempts ORDER BY id`).map(x => [x.form, x.ok]), [['backup', 0], ['draft', 1]]);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM gate_cards`).n, 0);
  const none = await T.authorize(db, { surface: 'outreach', action_class: 'send_as_owner', target: 'list-2', reversible_forms: [forms[0]] }, { policy: POLICY, now: NOW });
  assert.equal(none.refused, 'interrupt_gate');
  // irreversible and not identity-bound: denied by policy, never a card
  const denied = await T.authorize(db, { surface: 'repo', action_class: 'force_push_default_branch' }, { policy: POLICY, now: NOW });
  assert.deepEqual([denied.refused, denied.reason], ['denied', 'rewrites shared history; use revert']);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM gate_cards`).n, 1);
});

test('US-06-R13 standing limits take precedence over rung and score, and over an allow override', async () => {
  const db = mk();
  db.raw.prepare(`INSERT INTO trust_ledger (surface, action_class, rung, reliability) VALUES ('repo','open_pr','self-extending',1.0)`).run();
  db.raw.prepare(`INSERT INTO items (id, title, owner_role, done_check, status) VALUES ('I1','t','operations','d','claimed')`).run();
  db.raw.prepare(`INSERT INTO claims (item_id, agent) VALUES ('I1','other-agent')`).run();
  const base = { surface: 'repo', action_class: 'open_pr', executor: 'doer-1', required_rung: 'delegated' };
  const go = (extra) => T.authorize(db, { ...base, ...extra }, { policy: POLICY, now: NOW });
  assert.equal((await go({ target: 'a' })).allowed, true, 'the rung alone would allow it');
  const cases = [
    [{ target: 'b', limits: { harness: { refused: true, reason: 'command not permitted' } } }, 'harness'],
    [{ target: 'c', limits: { classifier: { refused: true } } }, 'classifier'],
    [{ target: 'd', limits: { touches_secret_value: true } }, 'secret_lock'],
    [{ target: 'e', limits: { outreach: { consent: false } } }, 'outreach_consent'],
    [{ target: 'f', limits: { outreach: { consent: true, opted_out: true } } }, 'outreach_consent'],
    [{ target: 'g', override: 'deny' }, 'principal_override'],
    [{ target: 'h', item_id: 'I1' }, 'live_claim'],
  ];
  for (const [extra, check] of cases) {
    const r = await go({ ...extra, override: extra.override || 'allow' });
    assert.deepEqual([r.allowed, r.refused, r.standing_limit], [false, check, true], check);
  }
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM trust_refusals`).n, 7, 'every refusal is recorded with its reason');
  assert.equal(one(db, `SELECT reason FROM trust_refusals WHERE check_name='live_claim'`).reason, 'item I1 is claimed by other-agent');
  assert.equal((await go({ target: 'i', item_id: 'I1', executor: 'other-agent' })).allowed, true, 'the claim holder itself is not blocked');
  // rung and ceiling still apply when no limit fires
  assert.equal((await go({ target: 'j', action_class: 'branch_commit_push', required_rung: 'autonomous' })).refused, 'rung_too_low');
  const ov = await go({ target: 'k', action_class: 'branch_commit_push', required_rung: 'autonomous', override: 'allow' });
  assert.deepEqual([ov.allowed, ov.override], [true, 'honored']);
  assert.equal(one(db, `SELECT event FROM trust_events`).event, 'principal_override', 'the override is recorded');
});

test('section 4, US-07-R08 a refusal is an input: the same action is not resubmitted in other words; a corrected condition may try once more', async () => {
  const db = mk();
  const act = { surface: 'repo', action_class: 'open_pr', target: 'PR-text-1', executor: 'doer-1' };
  const refused = (condition) => T.authorize(db, { ...act, condition, limits: { classifier: { refused: true, reason: 'text contains a credential-like string' } } }, { policy: POLICY, now: NOW });
  const plain = (condition) => T.authorize(db, { ...act, condition }, { policy: POLICY, now: NOW });
  const r1 = await refused('body v1');
  assert.deepEqual([r1.refused, r1.resubmission, r1.next], ['classifier', false, 'correct_condition_and_retry_once']);
  // the same change again, however the request is worded: the fingerprint is surface, action class and target
  const again = await plain('body v1');
  assert.deepEqual([again.allowed, again.refused, again.resubmission], [false, 'classifier', true]);
  assert.deepEqual(await T.maySubmit(db, { ...act, check: 'classifier', condition: 'body v2' }), { ok: true, retry: true });
  const r2 = await refused('body v2');
  assert.equal(r2.next, 'take_next_path');
  const third = await plain('body v3');
  assert.deepEqual([third.allowed, third.reason], [false, 'retry already used: take the next path']);
  assert.deepEqual(rows(db, `SELECT attempts FROM trust_refusals ORDER BY id`).map(x => x.attempts), [1, 1]);
  // a corrected condition that the check accepts goes through
  const other = { ...act, target: 'PR-text-2' };
  await T.authorize(db, { ...other, condition: 'v1', limits: { harness: { refused: true } } }, { policy: POLICY, now: NOW });
  assert.equal((await T.authorize(db, { ...other, condition: 'v2' }, { policy: POLICY, now: NOW })).allowed, true);
});

test('US-06-R09 a gate card needs a closing probe and a default in effect; the seed tick closes it by probe and never closes a manual one', async () => {
  const db = mk();
  const card = { id: 'G1', what: 'create the deploy credential', why_gated: 'only the principal can mint it', default_in_effect: 'deploys stay local', closing_probe: 'env:DEPLOY_TOKEN', identity_bound_line: 'the principal mints the credential' };
  await assert.rejects(T.openCard(db, { ...card, closing_probe: '' }), /closing_probe/);
  await assert.rejects(T.openCard(db, { ...card, default_in_effect: ' ' }), /default_in_effect/);
  await T.openCard(db, card, { now: NOW });
  await T.openCard(db, { ...card, id: 'G2', closing_probe: 'manual', priority: 5 }, { now: NOW });
  assert.deepEqual((await T.gateQueue(db)).map(c => c.id), ['G2', 'G1'], 'queue is ordered by priority');
  const config = { policy: POLICY, claim_ttl_minutes: 60, max_wip_per_role: 2, plus_share: 0.2 };
  await runTick(db, { config, now: NOW, env: {} });
  assert.equal((await T.gateQueue(db)).length, 2);
  await runTick(db, { config, now: NOW + 600e3, env: { DEPLOY_TOKEN: 'present' } });
  assert.deepEqual((await T.gateQueue(db)).map(c => c.id), ['G2'], 'the env card closed itself; the manual card was not closed by the tick');
});

test('US-06-R15 a step with no identity-bound line is rerouted to the staff, and the count of such open cards returns to zero', async () => {
  const db = mk();
  const r = await T.openCard(db, { id: 'G3', what: 'rename the staging bucket', why_gated: 'unsure', default_in_effect: 'old name stays', closing_probe: 'manual', identity_bound_line: '' }, { now: NOW });
  assert.deepEqual(r, { id: null, rerouted: true, item: 'REROUTE-G3' });
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM gate_cards`).n, 0);
  assert.equal(one(db, `SELECT owner_role FROM items WHERE id='REROUTE-G3'`).owner_role, 'operations');
  // cards opened elsewhere: a credential card is identity-bound by its probe; a card with no line is not
  db.raw.prepare(`INSERT INTO gate_cards (id, what, why_gated, default_in_effect, closing_probe) VALUES ('B1','mint API token','owner only','local only','env:API_TOKEN'), ('B2','tidy the backlog labels','asked','labels stay','manual')`).run();
  assert.equal(await T.cardsWithoutIdentityLine(db), 1);
  assert.deepEqual(await T.rerouteUnbound(db, { now: NOW }), [{ card: 'B2', item: 'REROUTE-B2' }]);
  assert.equal(await T.cardsWithoutIdentityLine(db), 0);
  assert.deepEqual((await T.gateQueue(db)).map(c => c.id), ['B1']);
  assert.equal(one(db, `SELECT status FROM gate_cards WHERE id='B2'`).status, 'closed');
  assert.equal(one(db, `SELECT rerouted_to FROM trust_gate_meta WHERE card_id='B2'`).rerouted_to, 'REROUTE-B2');
});

test('US-06-R16 a reversible, in-scope question is answered by executing the default, with a decision row and revert path; otherwise it is not adopted', async () => {
  const db = mk();
  const q = { question: 'Should the stale preview be removed?', recommended_default: 'remove preview pr-12', revert_path: 'redeploy preview pr-12 from its branch', reversible: true, in_scope: true, surface: 'runtime', action_class: 'deploy_preview', executor: 'ops-1' };
  const ran = [];
  const r = await T.adoptDefault(db, q, { now: NOW, execute: async (d) => { ran.push(d); return { verified: true, evidence: 'preview list no longer contains pr-12' }; } });
  assert.deepEqual([r.adopted, r.verified, r.report], [true, true, 'Done: remove preview pr-12. Revert: redeploy preview pr-12 from its branch.']);
  assert.deepEqual(ran, ['remove preview pr-12']);
  assert.deepEqual({ ...one(db, `SELECT default_taken, revert_path, verified FROM trust_adoptions`) }, { default_taken: 'remove preview pr-12', revert_path: 'redeploy preview pr-12 from its branch', verified: 1 });
  assert.equal(one(db, `SELECT event FROM trust_events`).event, 'verified_autonomous_action');
  const failed = await T.adoptDefault(db, q, { now: NOW, execute: async () => { throw new Error('api 500'); } });
  assert.deepEqual([failed.adopted, failed.verified], [true, false]); assert.match(failed.report, /^Open: .*not verified \(execution failed: api 500\)/);
  let called = 0;
  const no = await T.adoptDefault(db, { ...q, reversible: false }, { execute: () => { called++; } });
  assert.deepEqual([no.adopted, called], [false, 0]);
  await assert.rejects(T.adoptDefault(db, { ...q, revert_path: '' }, { execute: () => ({}) }), /revert_path/);
});

test('step validates the policy, recomputes and reroutes in one pass; an invalid policy stops it', async () => {
  const db = mk();
  outcomes(db, 'outreach', 'draft', 'verified', 12, { agent: 'writer-1' });
  const r = await T.step({ db, policy: POLICY, now: NOW });
  assert.deepEqual(r, { pairs: 1, executors: 1, proposed: ['LADDER-outreach-draft-assisted'], rerouted: 0, cards_without_identity_line: 0 });
  const bad = clone(POLICY); bad.surfaces.money.start_rung = 'autonomous';
  await assert.rejects(T.step({ db, policy: bad, now: NOW }), /invalid policy/);
});
