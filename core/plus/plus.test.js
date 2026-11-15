// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb } from '../_shared/testdb.js';
import { runTick, STEP_ORDER } from '../src/tick.js';
import { MIGRATIONS_DIR as KERNEL_DIR, registerProgram, snapshotRisk, allocate } from '../kernel/index.js';
import {
  MIGRATIONS_DIR, registerProduct, reduceShare, effectiveShare, capacity, recordReading, latestReading, measureUsage, selectDue, cycleKind,
  gatherEvidence, proposePlus, shipPlus, decidePlus, decideDue, principalStep, runCycle, weeklyDigest, detect, plusStep,
} from './index.js';

const policy = JSON.parse(readFileSync(new URL('../../autonomy/policy.json', import.meta.url), 'utf8'));
const config = { org_slug: 't', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy };
const NOW = Date.parse('2026-11-09T12:00:00Z'), HOUR = 3600e3, DAY = 24 * HOUR;   // a Monday
const ts = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const one = (db, sql, ...a) => db.raw.prepare(sql).get(...a);
const rows = (db, sql, ...a) => db.raw.prepare(sql).all(...a);
const done = (db, n, kind, at = NOW) => { for (let i = 0; i < n; i++) db.raw.prepare(`INSERT INTO items (id, title, kind, owner_role, done_check, status, disposition, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
  .run(`${kind}-${i}-${Math.random().toString(36).slice(2, 8)}`, 't', kind, 'nobody', 'x', 'done', 'done', ts(at - i * 1000)); };

async function product(db, o = {}) {
  await registerProduct(db, { product: 'desk', host: 'desk.example', program: 'REACH', usage_metric: 'requests_per_day', quality_measure: 'error_page_rate', now: NOW - 30 * DAY, ...o });
}
const read = (db, usage, guard, now, product = 'desk') => Promise.all([
  recordReading(db, { product, measure: 'requests_per_day', value: usage, now }), recordReading(db, { product, measure: 'error_page_rate', value: guard, now })]);
const plus = (o = {}) => ({ product: 'desk', title: 'Add a today summary', evidence: 'usage flat for 3 weeks', prediction: { metric: 'requests_per_day', direction: 'up', size: 0.10 },
  additive: true, changes: 1, revert_path: 'remove the summary block', doer: 'staff: site/home.js', angle: 'summary on the home page', ...o });

test('US-04-T01: 20 done items with 1 plus opens one REBALANCE item for the portfolio manager at priority 5', async () => {
  const db = makeDb([MIGRATIONS_DIR]); done(db, 19, 'work'); done(db, 1, 'plus');
  const r = await runTick(db, { config, now: NOW }); assert.deepEqual(r.errors, []);
  await runTick(db, { config, now: NOW + HOUR });                                            // the same day: still one
  const it = rows(db, `SELECT * FROM items WHERE id LIKE 'REBALANCE-%'`);
  assert.equal(it.length, 1);
  assert.deepEqual([it[0].id, it[0].owner_role, it[0].priority], ['REBALANCE-2026-11-09', 'portfolio-manager', 5]);
});

test('US-04-T02: 9 done items open no rebalance item; 20 with a healthy plus share open none either', async () => {
  const db = makeDb([MIGRATIONS_DIR]); done(db, 9, 'work');
  await runTick(db, { config, now: NOW });
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM items WHERE id LIKE 'REBALANCE-%'`).n, 0);
  done(db, 7, 'work'); done(db, 4, 'plus');                                                  // 4 of 20 = the 0.2 target
  await runTick(db, { config, now: NOW + HOUR });
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM items WHERE id LIKE 'REBALANCE-%'`).n, 0);
});

test('US-04-R01, US-04-R05: the reserved share is configuration, is lowered only by a row with an expiry, and risk cannot take it', async () => {
  const db = makeDb([KERNEL_DIR, MIGRATIONS_DIR]);
  assert.deepEqual(await capacity(db, { T: 25, now: NOW }), { share: 0.2, base: 0.2, override_until: null, total: 25, plus_slots: 5, repair_slots: 20 });
  assert.equal((await capacity(db, { T: 25, now: NOW, config: { plus_share: 0.4 } })).plus_slots, 10);
  await assert.rejects(reduceShare(db, { share: 0.1, reason: 'incident', now: NOW }), /expiry/);
  await assert.rejects(reduceShare(db, { share: 0.1, reason: 'incident', expires_at: ts(NOW - HOUR), now: NOW }), /expiry in the future/);
  await assert.rejects(reduceShare(db, { share: 0.1, expires_at: ts(NOW + DAY), now: NOW }), /reason/);
  await reduceShare(db, { share: 0.08, reason: 'incident week', expires_at: ts(NOW + 2 * DAY), now: NOW });
  assert.deepEqual([(await capacity(db, { T: 25, now: NOW + DAY })).plus_slots, (await effectiveShare(db, { now: NOW + DAY })).override_until], [2, ts(NOW + 2 * DAY)]);
  assert.equal((await capacity(db, { T: 25, now: NOW + 3 * DAY })).plus_slots, 5);            // the row expired: the share is back
  await reduceShare(db, { share: 0.9, reason: 'an override never raises repair above the base', expires_at: ts(NOW + 9 * DAY), now: NOW + 3 * DAY });
  assert.equal((await effectiveShare(db, { now: NOW + 4 * DAY })).share, 0.2);

  // the kernel allocation takes the plus slots off before it reads any risk: ten times the risk, the same reserve
  for (const [id, n] of [['OPS', 3], ['REACH', 1]]) {
    await registerProgram(db, { id, name: id });
    for (let i = 0; i < n; i++) db.raw.prepare(`INSERT INTO items (id, title, owner_role, done_check, priority, status, project) VALUES (?,?,?,?,?,?,?)`).run(`${id}-${i}`, 't', 'staff', 'x', 0, 'ready', id);
  }
  const total = async (tick) => { const k = { slots: 25, plus_slots: (await capacity(db, { T: 25, now: NOW + 3 * DAY })).plus_slots };
    await snapshotRisk(db, { tickId: tick, now: NOW, config: k }); return Object.values(await allocate(db, { tickId: tick, now: NOW, config: k })).reduce((s, a) => s + a.slots, 0); };
  assert.equal(await total(1), 20);
  for (let i = 0; i < 30; i++) db.raw.prepare(`INSERT INTO items (id, title, owner_role, done_check, priority, status, project) VALUES (?,?,?,?,?,?,?)`).run(`OPS-x${i}`, 't', 'staff', 'x', 0, 'blocked', 'OPS');
  assert.equal(await total(2), 20);
});

test('US-04-R06, R07, R08: a plus states its prediction first, is additive, reversible and single, has a separate guard, and is filed as a work item with a doer line', async () => {
  const db = makeDb([MIGRATIONS_DIR]); await product(db); await read(db, 1240, 0.8, NOW);
  await assert.rejects(registerProduct(db, { product: 'x', usage_metric: 'm', quality_measure: 'm' }), /guard measure must differ/);
  const bad = (o, re) => assert.rejects(proposePlus(db, plus({ now: NOW, ...o })), re);
  await bad({ prediction: { metric: 'requests_per_day', direction: 'up' } }, /states its prediction first/);
  await bad({ prediction: { metric: 'requests_per_day', direction: 'sideways', size: 0.1 } }, /prediction/);
  await bad({ additive: false }, /additive/);
  await bad({ changes: 3 }, /single change/);
  await bad({ revert_path: '' }, /reversible/);
  await bad({ guard: 'requests_per_day' }, /guard measure must differ/);
  await bad({ doer: null }, /doer line/);
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM plus_ledger`).n, 0);
  const r = await proposePlus(db, plus({ now: NOW }));
  assert.deepEqual([r.kind, r.predicted_outcome, r.issue_id], ['plus', 'requests_per_day up 10% within 168 h', `PLUS-desk-${r.id}`]);
  const it = one(db, `SELECT * FROM items WHERE id = ?`, r.issue_id);
  assert.deepEqual([it.kind, it.status, it.project, it.owner_role], ['plus', 'ready', 'REACH', 'staff']);
  assert.match(it.done_check, /^doer: staff: site\/home.js\./); assert.match(it.done_check, /revert: remove the summary block/);
  const l = one(db, `SELECT status, guard, metric FROM plus_ledger WHERE id = ?`, r.id);
  assert.deepEqual({ ...l }, { status: 'filed', guard: 'error_page_rate', metric: 'requests_per_day' });
  await bad({ title: 'A second one' }, /already has a plus in flight/);
  await assert.rejects(shipPlus(db, r.id, { now: NOW }), /evidence of the verified deployment/);
});

test('US-04-T03, US-04-R10: the worked example. +13.7% with a better guard is kept and seeds the next; -0.7% files a revert and counts one miss', async () => {
  const db = makeDb([MIGRATIONS_DIR]); await product(db); await read(db, 1240, 0.8, NOW);
  const a = await proposePlus(db, plus({ now: NOW }));
  assert.deepEqual(await shipPlus(db, a.id, { evidence: 'deploy 41 probed 200', now: NOW }), { id: a.id, baseline: 1240, guard_baseline: 0.8, due_at: ts(NOW + 7 * DAY) });
  assert.equal((await decidePlus(db, a.id, { now: NOW + 6 * DAY })).pending, true);          // not before the window ends
  await read(db, 1410, 0.7, NOW + 7 * DAY);
  const k = await decidePlus(db, a.id, { now: NOW + 7 * DAY });
  assert.deepEqual([k.status, k.outcome, k.misses_in_row], ['kept', 1410, 0]);
  const p1 = one(db, `SELECT misses_in_row, pluses_since_simplify, last_plus_at FROM plus_product_registry WHERE product = 'desk'`);
  assert.deepEqual({ ...p1 }, { misses_in_row: 0, pluses_since_simplify: 1, last_plus_at: ts(NOW + 7 * DAY) });
  assert.equal(one(db, `SELECT prediction_hit FROM plus_ledger WHERE id = ?`, a.id).prediction_hit, 1);
  const seed = one(db, `SELECT * FROM plus_ledger WHERE id = ?`, k.seeded);
  assert.deepEqual([seed.status, seed.seeded_from, seed.title], ['proposed', a.id, 'Build on: Add a today summary']);

  // the second plus is written onto the seed row, predicts +5%, and lands at -0.7%
  const b = await proposePlus(db, plus({ title: 'Add the two links the summary refers to', prediction: { metric: 'requests_per_day', direction: 'up', size: 0.05 }, angle: 'links from the summary', now: NOW + 7 * DAY }));
  assert.equal(b.id, k.seeded);
  await shipPlus(db, b.id, { evidence: 'deploy 42 probed 200', now: NOW + 7 * DAY });
  await read(db, 1400, 0.7, NOW + 14 * DAY);
  const m = await decidePlus(db, b.id, { now: NOW + 14 * DAY });
  assert.deepEqual([m.status, m.verdict, m.misses_in_row, m.revert_item, m.rest_until], ['reverted', 'missed', 1, `PLUSREVERT-${b.id}`, null]);
  const rv = one(db, `SELECT owner_role, priority, done_check FROM items WHERE id = ?`, m.revert_item);
  assert.deepEqual({ ...rv }, { owner_role: 'operations', priority: 5, done_check: 'reverted via: remove the summary block' });
  assert.equal(one(db, `SELECT kind FROM plus_ledger WHERE issue_id = ?`, m.revert_item).kind, 'revert');
  // the next plus must take a different angle
  await assert.rejects(proposePlus(db, plus({ title: 'More links', angle: 'Links from the summary!', now: NOW + 15 * DAY })), /take a different angle/);
  assert.equal((await gatherEvidence(db, 'desk', { now: NOW + 15 * DAY })).avoid_angle, 'links from the summary');
  assert.equal((await proposePlus(db, plus({ title: 'Faster first paint', angle: 'load time', now: NOW + 15 * DAY }))).kind, 'plus');
});

test('US-04-R08: a gain in the outcome with a worse guard is reverted at priority 0, not kept', async () => {
  const db = makeDb([MIGRATIONS_DIR]); await product(db); await read(db, 1000, 0.8, NOW);
  const a = await proposePlus(db, plus({ now: NOW })); await shipPlus(db, a.id, { evidence: 'deployed', now: NOW });
  await read(db, 1500, 1.9, NOW + 7 * DAY);
  const r = await decidePlus(db, a.id, { now: NOW + 7 * DAY });
  assert.deepEqual([r.status, r.verdict], ['reverted', 'guard_worse']);
  assert.equal(one(db, `SELECT priority FROM items WHERE id = ?`, r.revert_item).priority, 0);
  // a guard where higher is better, with a tolerance
  await product(db, { product: 'api', quality_measure: 'success_rate', quality_direction: 'higher' });
  await recordReading(db, { product: 'api', measure: 'requests_per_day', value: 100, now: NOW }); await recordReading(db, { product: 'api', measure: 'success_rate', value: 0.99, now: NOW });
  const b = await proposePlus(db, plus({ product: 'api', now: NOW })); await shipPlus(db, b.id, { evidence: 'deployed', now: NOW });
  await recordReading(db, { product: 'api', measure: 'requests_per_day', value: 120, now: NOW + 7 * DAY }); await recordReading(db, { product: 'api', measure: 'success_rate', value: 0.985, now: NOW + 7 * DAY });
  assert.equal((await decidePlus(db, b.id, { now: NOW + 7 * DAY, config: { guard_tolerance: 0.01 } })).status, 'kept');
});

test('US-04-T04, US-04-R09: a stale or failed usage reading at the window end is recorded unmeasured (null), never 0, and is not kept', async () => {
  const db = makeDb([MIGRATIONS_DIR]); await product(db); await read(db, 1240, 0.8, NOW);
  const a = await proposePlus(db, plus({ now: NOW })); await shipPlus(db, a.id, { evidence: 'deployed', now: NOW });
  await read(db, 5000, 0.1, NOW + 3 * DAY);                                                   // a fine reading, but 4 days old at the window end
  assert.equal((await latestReading(db, 'desk', 'requests_per_day', { now: NOW + 7 * DAY })).value, null);
  const r = await decidePlus(db, a.id, { now: NOW + 7 * DAY });
  assert.deepEqual([r.status, r.verdict, r.outcome], ['shipped', 'unmeasured', null]);
  const l = one(db, `SELECT status, outcome, verdict FROM plus_ledger WHERE id = ?`, a.id);
  assert.deepEqual({ ...l }, { status: 'shipped', outcome: null, verdict: 'unmeasured' });
  assert.equal(one(db, `SELECT misses_in_row FROM plus_product_registry WHERE product='desk'`).misses_in_row, 0);
  assert.equal(one(db, `SELECT owner_role FROM items WHERE id = ?`, `PLUSMEASURE-${a.id}`).owner_role, 'operations');
  // a failed read is stored as null, not 0
  assert.equal(await recordReading(db, { product: 'desk', measure: 'requests_per_day', value: undefined, evidence: 'reader timed out', now: NOW + 8 * DAY }), null);
  assert.equal(one(db, `SELECT usage_value FROM plus_product_registry WHERE product='desk'`).usage_value, null);
  assert.equal((await decidePlus(db, a.id, { now: NOW + 8 * DAY })).verdict, 'unmeasured');
  // still unmeasured after the grace period: an unproven plus does not stay. It is reverted and counts as a miss.
  const late = await decidePlus(db, a.id, { now: NOW + 15 * DAY });
  assert.deepEqual([late.status, late.verdict, late.outcome, late.misses_in_row], ['reverted', 'unmeasured', null, 1]);
});

test('US-04-R10: three misses in a row set rest_until; a product at rest is not selected and takes no plus', async () => {
  const db = makeDb([MIGRATIONS_DIR]); await product(db);
  let now = NOW; await read(db, 1000, 0.8, now);
  for (const [i, angle] of ['one', 'two', 'three'].entries()) {
    const a = await proposePlus(db, plus({ title: `try ${angle}`, angle, now })); await shipPlus(db, a.id, { evidence: 'deployed', now });
    now += 7 * DAY; await read(db, 1000, 0.8, now);
    const r = await decidePlus(db, a.id, { now });
    assert.equal(r.misses_in_row, i + 1); assert.equal(r.rest_until, i === 2 ? ts(now + 14 * DAY) : null);
  }
  assert.equal(one(db, `SELECT rest_until FROM plus_product_registry WHERE product='desk'`).rest_until, ts(now + 14 * DAY));
  assert.match(one(db, `SELECT title FROM items WHERE id LIKE 'PLUSREST-desk-%'`).title, /review a different user or surface/);
  assert.deepEqual(await selectDue(db, { now: now + DAY }), []);
  await assert.rejects(proposePlus(db, plus({ angle: 'four', now: now + DAY })), /at rest until/);
  await read(db, 1000, 0.8, now + 15 * DAY);
  assert.deepEqual((await selectDue(db, { now: now + 15 * DAY })).map(p => p.product), ['desk']);   // rest is over
});

test('US-04-R11: every fifth cycle is a simplify pass, which may remove and resets the count; no usage reading makes a measurement cycle', async () => {
  const db = makeDb([MIGRATIONS_DIR]); await product(db);
  const p = () => one(db, `SELECT * FROM plus_product_registry WHERE product='desk'`);
  assert.equal(await cycleKind(db, p(), { now: NOW }), 'measurement');
  let now = NOW; const kinds = [];
  for (let i = 0; i < 6; i++) {
    await read(db, 1000 * 1.1 ** i, 0.8, now);
    const kind = await cycleKind(db, p(), { now }); kinds.push(kind);
    const a = await proposePlus(db, plus({ title: `cycle ${i}`, angle: `angle ${i}`, now, ...(kind === 'simplify' ? { additive: false, changes: 4, title: 'Remove three unused panels' } : {}) }));
    assert.equal(a.kind, kind);
    await shipPlus(db, a.id, { evidence: 'deployed', now }); now += 7 * DAY; await read(db, 1000 * 1.1 ** (i + 1), 0.8, now);
    assert.equal((await decidePlus(db, a.id, { now })).status, 'kept');
  }
  assert.deepEqual(kinds, ['plus', 'plus', 'plus', 'plus', 'simplify', 'plus']);
  assert.equal(p().pluses_since_simplify, 1);
  assert.equal(await cycleKind(db, { ...p(), pluses_since_simplify: 2 }, { now, config: { n_simplify: 3 } }), 'simplify');
});

test('selection (step 402): active, not at rest, nothing in flight, cadence elapsed; ordered by age times usage weight times friction', async () => {
  const db = makeDb([MIGRATIONS_DIR]);
  for (const [name, usage] of [['big', 900], ['small', 100], ['busy', 100], ['fresh', 500], ['off', 500], ['flying', 500]]) {
    await registerProduct(db, { product: name, program: name, usage_metric: 'requests_per_day', quality_measure: 'error_page_rate', state: name === 'off' ? 'paused' : 'active', now: NOW - 30 * DAY });
    await read(db, usage, 0.5, NOW, name);
    db.raw.prepare(`UPDATE plus_product_registry SET last_plus_at = ? WHERE product = ?`).run(ts(name === 'fresh' ? NOW - 2 * HOUR : NOW - 10 * DAY), name);
  }
  for (const id of ['F1', 'F2', 'F3']) db.raw.prepare(`INSERT INTO items (id, title, kind, owner_role, done_check, status, project) VALUES (?, 't', 'fix', 'staff', 'x', 'ready', 'busy')`).run(id);
  await proposePlus(db, plus({ product: 'flying', now: NOW }));
  const due = await selectDue(db, { now: NOW });
  assert.deepEqual(due.map(p => p.product), ['busy', 'big', 'small']);                          // 240*(1+1/9)*4, 240*2*1, 240*(1+1/9)*1
  assert.deepEqual([due[0].friction_count, due[1].usage_weight], [3, 1]);
  assert.ok(Math.abs(due[1].due_score - 480) < 1e-6);
});

test('one cycle (steps 402 to 408): measurement first, then the proposer writes the plus; without a proposer the writing is a work item; daily cap', async () => {
  const db = makeDb([MIGRATIONS_DIR]);
  for (const name of ['a', 'b', 'c', 'd', 'e']) await registerProduct(db, { product: name, program: 'P', usage_metric: 'requests_per_day', quality_measure: 'error_page_rate', now: NOW - 30 * DAY });
  const first = await runCycle(db, { now: NOW });
  assert.deepEqual(first.map(r => [r.kind, r.filed]), ['a', 'b', 'c', 'd', 'e'].map(n => ['measurement', `PLUSUSAGE-${n}`]));
  await runCycle(db, { now: NOW + HOUR });                                                    // no second measurement row
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM plus_ledger WHERE kind = 'measurement'`).n, 5);
  for (const name of ['a', 'b', 'c', 'd', 'e']) await read(db, 100, 0.5, NOW + DAY, name);
  assert.equal((await decideDue(db, { now: NOW + DAY })).filter(r => r.verdict === 'measured').length, 5);

  const asked = [];
  const propose = async ({ product, kind, evidence }) => { asked.push([product, kind, evidence.usage.value]); return product === 'b' ? plus({ doer: null }) : plus({ title: `plus for ${product}` }); };
  const cyc = await runCycle(db, { now: NOW + 3 * DAY, propose });
  assert.deepEqual(asked[0], ['a', 'plus', 100]);
  assert.deepEqual(cyc.map(r => r.issue_id ? 'filed' : r.skipped ? 'capped' : 'write-item'), ['filed', 'write-item', 'filed', 'filed', 'capped']);   // cap 3 a day
  assert.match(cyc[1].refused, /doer line/);
  const w = one(db, `SELECT * FROM items WHERE id = 'PLUSWRITE-b-20261112'`);
  assert.deepEqual([w.owner_role, w.kind], ['product-manager', 'work']); assert.doesNotMatch(w.title, /\?/);
  for (const name of ['b', 'e']) await read(db, 100, 0.5, NOW + 4 * DAY, name);
  const none = await runCycle(db, { now: NOW + 4 * DAY });                                    // no proposer at all
  assert.deepEqual(none.map(r => r.filed), ['PLUSWRITE-b-20261113', 'PLUSWRITE-e-20261113']);
});

test('US-04-R12: a step only the principal can take is exactly one gate card with a default in effect, and never a question', async () => {
  const db = makeDb([MIGRATIONS_DIR]);
  const card = { what: 'Connect the payment account for the tip jar', why_gated: 'identity-bound: the owner\'s account', default_in_effect: 'the tip jar stays hidden', closing_probe: 'env:PAYMENT_KEY' };
  await assert.rejects(principalStep(db, 7, { ...card, what: 'Should we add a tip jar?' }), /not a question/);
  await assert.rejects(principalStep(db, 7, { ...card, default_in_effect: '' }), /default_in_effect/);
  assert.deepEqual(await principalStep(db, 7, card), { id: 'PLUSGATE-7', created: true });
  assert.deepEqual(await principalStep(db, 7, card), { id: 'PLUSGATE-7', created: false });
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM gate_cards`).n, 1);
});

test('US-04-R14, R09: usage comes through a reader port; machine requests counted with human ones are labelled; a failing reader stores null', async () => {
  const db = makeDb([MIGRATIONS_DIR]);
  for (const name of ['mixed', 'human', 'silent', 'down']) await registerProduct(db, { product: name, host: `${name}.example`, usage_metric: 'requests_per_day', quality_measure: 'error_page_rate', now: NOW });
  const reader = async ({ product, host }) => {
    assert.equal(host, `${product}.example`);
    if (product === 'down') throw new Error('analytics unavailable');
    return { value: 1240, window_h: 24, ...(product === 'mixed' ? { includes_machine: true } : product === 'human' ? { includes_machine: false } : {}) };
  };
  const r = await measureUsage(db, { reader, now: NOW });
  const by = Object.fromEntries(r.map(x => [x.product, x]));
  assert.match(by.mixed.label, /machine and human requests counted together/);
  assert.match(by.human.label, /human requests/); assert.match(by.silent.label, /machine share unknown/);
  assert.equal(by.down.value, null);
  const reg = one(db, `SELECT usage_value, usage_window, usage_read_at, usage_label FROM plus_product_registry WHERE product = 'mixed'`);
  assert.deepEqual({ ...reg }, { usage_value: 1240, usage_window: '24 h', usage_read_at: ts(NOW), usage_label: 'requests_per_day (machine and human requests counted together)' });
  assert.equal(one(db, `SELECT usage_value FROM plus_product_registry WHERE product = 'down'`).usage_value, null);
  assert.match(one(db, `SELECT evidence FROM plus_readings WHERE product = 'down'`).evidence, /analytics unavailable/);
});

test('weekly digest and US-04-R13: one row per product per week with shipped, kept and reverted; unmeasured usage and a stale digest raise items', async () => {
  const db = makeDb([MIGRATIONS_DIR]); await product(db); await product(db, { product: 'quiet' });
  await read(db, 1000, 0.8, NOW);
  const a = await proposePlus(db, plus({ now: NOW })); await shipPlus(db, a.id, { evidence: 'deployed', now: NOW });
  await read(db, 1200, 0.8, NOW + 7 * DAY); await decidePlus(db, a.id, { now: NOW + 7 * DAY });
  const b = await proposePlus(db, plus({ title: 'second', angle: 'second', now: NOW + 7 * DAY })); await shipPlus(db, b.id, { evidence: 'deployed', now: NOW + 8 * DAY });
  const d = await weeklyDigest(db, { now: NOW + 8 * DAY });
  assert.deepEqual(d, [{ week: '2026-11-16', product: 'desk', shipped: 1, kept: 1, reverted: 0 }, { week: '2026-11-16', product: 'quiet', shipped: 0, kept: 0, reverted: 0 }]);
  await weeklyDigest(db, { now: NOW + 8 * DAY });
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM plus_digest`).n, 2);
  await read(db, 1200, 0.8, NOW + 9 * DAY);
  assert.deepEqual(await detect(db, { now: NOW + 9 * DAY }), ['PLUSUSAGE-quiet']);            // desk is measured, the digest is fresh
  assert.deepEqual(await detect(db, { now: NOW + 9 * DAY }), []);                             // filed once
  assert.deepEqual(await detect(db, { now: NOW + 20 * DAY }), ['PLUSUSAGE-desk', 'PLUSDIGEST-stale-2026-11-29']);
});

test('the plus loop runs as a tick step: reads usage, starts a cycle, writes the digest, never errors the tick', async () => {
  const db = makeDb([MIGRATIONS_DIR]); await product(db); await read(db, 0.8, 0.8, NOW - DAY);
  let usage = 1240;
  const step = plusStep({ reader: async () => ({ value: usage, window_h: 24, includes_machine: true }), propose: async () => plus() });
  const r1 = await runTick(db, { config, now: NOW, extraSteps: [step] });
  assert.equal(r1.total, STEP_ORDER.length + 1); assert.deepEqual(r1.errors, []); assert.match(r1.report, /plus: 0 decided, 1 cycle\(s\), 0 detector item\(s\)/);
  const l = one(db, `SELECT id, status FROM plus_ledger WHERE product = 'desk'`); assert.equal(l.status, 'filed');
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM plus_digest`).n, 1);
  await recordReading(db, { product: 'desk', measure: 'error_page_rate', value: 0.8, now: NOW }); await shipPlus(db, l.id, { evidence: 'deployed', now: NOW });
  usage = 1410; await recordReading(db, { product: 'desk', measure: 'error_page_rate', value: 0.7, now: NOW + 7 * DAY });
  const r2 = await runTick(db, { config, now: NOW + 7 * DAY, extraSteps: [step] });
  assert.match(r2.report, /plus: 1 decided/);
  assert.equal(one(db, `SELECT status FROM plus_ledger WHERE id = ?`, l.id).status, 'kept');
  assert.equal(one(db, `SELECT COUNT(*) AS n FROM plus_digest`).n, 2);
  const off = await runTick(db, { config: { ...config, plus: { enabled: false } }, now: NOW + 8 * DAY, extraSteps: [step] });
  assert.match(off.report, /plus: off/);
});
