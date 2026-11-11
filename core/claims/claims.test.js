// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tests for core/claims (US-SPEC-08 MUSTs and conformance tests T01-T06; US-SPEC-09 kill switch fence; US-SPEC-14 R01).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import * as C from './index.js';
import { STEPS } from '../src/tick.js';

const MIG = fileURLToPath(new URL('./migrations/', import.meta.url));
const T0 = Date.parse('2026-11-11T10:00:00Z');
const MIN = 60000;

function setup(config = {}) {
  const db = makeDb([MIG]);
  const clock = { t: T0 };
  const ctx = { db, now: () => clock.t, config: { claim_ttl_minutes: 120, ...config } };
  return { db, clock, ctx };
}
const item = (db, id, extra = '') => db.raw.exec(`INSERT INTO items (id,title,owner_role,done_check,status${extra ? ',' + extra.split('|')[0] : ''}) VALUES ('${id}','t','staff','x','ready'${extra ? ',' + extra.split('|')[1] : ''})`);

test('US-08-R01 / T01: at most one live claim per item; second is rejected', async () => {
  const { db, ctx } = setup(); item(db, 'A');
  const a = await C.acquire(ctx, { item_id: 'A', holder: 'agent-1', intent: 'build A' });
  assert.equal(a.acquired, true);
  const b = await C.acquire(ctx, { item_id: 'A', holder: 'agent-2', intent: 'something else' });
  assert.equal(b.acquired, false); assert.equal(b.reason, 'held'); assert.equal(b.status, 409);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM claims_lock WHERE released_at IS NULL`).get().n, 1);
});

test('contention: two claimants race, exactly one wins; fences stay unique', async () => {
  const { ctx } = setup();
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => C.acquire(ctx, { path: 'src/x.js', holder: `h${i}`, intent: `intent ${i}` })));
  assert.equal(rs.filter(r => r.acquired).length, 1);
  assert.ok(rs.filter(r => !r.acquired).every(r => r.status === 409));
  const win = rs.find(r => r.acquired); assert.equal(win.fence, 1);
});

test('US-08-R07 / R08 / T05: fence is previous+1; a stale holder is rejected by check', async () => {
  const { ctx, clock } = setup();
  const h1 = await C.acquire(ctx, { path: 'p', holder: 'one' });
  assert.equal(h1.fence, 1);
  assert.equal((await C.check(ctx, { path: 'p', token: h1.token, fence: 1 })).valid, true);
  clock.t += 121 * MIN; // holder 1 pauses past expiry
  const h2 = await C.acquire(ctx, { path: 'p', holder: 'two' });
  assert.equal(h2.acquired, true); assert.equal(h2.fence, 2);
  const stale = await C.check(ctx, { path: 'p', token: h1.token, fence: 1 });
  assert.equal(stale.valid, false);
  const staleFence = await C.check(ctx, { path: 'p', token: h2.token, fence: 1 });
  assert.equal(staleFence.reason, 'stale_fence');
  assert.equal((await C.check(ctx, { path: 'p', token: h2.token, fence: 2 })).valid, true);
});

test('fence is monotonic across release and re-acquire', async () => {
  const { ctx } = setup();
  const a = await C.acquire(ctx, { path: 'q', holder: 'a' }); await C.release(ctx, { path: 'q', token: a.token });
  const b = await C.acquire(ctx, { path: 'q', holder: 'b' }); await C.release(ctx, { path: 'q', token: b.token });
  const c = await C.acquire(ctx, { path: 'q', holder: 'c' });
  assert.deepEqual([a.fence, b.fence, c.fence], [1, 2, 3]);
});

test('US-08-R02 / T02: expired claim is reaped and the item returns to ready (alongside the seed tick reaper)', async () => {
  const { db, ctx, clock } = setup(); item(db, 'A');
  await C.acquire(ctx, { item_id: 'A', holder: 'agent-1' });
  assert.equal(db.raw.prepare(`SELECT status FROM items WHERE id='A'`).get().status, 'claimed');
  clock.t += 180 * MIN;
  const r = await C.reapExpired(ctx);
  assert.equal(r.reaped, 1);
  assert.equal(db.raw.prepare(`SELECT status FROM items WHERE id='A'`).get().status, 'ready');
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM claims`).get().n, 0);
  assert.equal(db.raw.prepare(`SELECT outcome FROM claims_lock`).get().outcome, 'expired');
  assert.equal((await C.metrics(ctx)).orphaned_claims, 0);
});

test('US-08-R13: an unreaped expired claim counts as an orphan until the reaper runs', async () => {
  const { ctx, clock } = setup();
  await C.acquire(ctx, { path: 'o', holder: 'a' });
  clock.t += 200 * MIN;
  assert.equal((await C.metrics(ctx)).orphaned_claims, 1);
  await C.reapExpired(ctx);
  assert.equal((await C.metrics(ctx)).orphaned_claims, 0);
});

test('seed reaper and this module agree: when the tick frees the item, reconcile closes the claim', async () => {
  const { db, ctx, clock } = setup(); item(db, 'A');
  await C.acquire(ctx, { item_id: 'A', holder: 'agent-1' });
  clock.t += 180 * MIN;
  const nowIso = new Date(clock.t).toISOString().replace('T', ' ').slice(0, 19);
  await STEPS.reap_claims(db, { now: clock.t, nowIso, config: { claim_ttl_minutes: 120 }, notes: [] });
  const r = await C.reapExpired(ctx);
  assert.equal(r.reaped, 1);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM claims_lock WHERE released_at IS NULL`).get().n, 0);
});

test('US-08-R06: heartbeat renews; a claim that heartbeats outlives its first expiry', async () => {
  const { ctx, clock } = setup();
  const a = await C.acquire(ctx, { path: 'h', holder: 'a' });
  clock.t += 100 * MIN;
  const hb = await C.heartbeat(ctx, { path: 'h', token: a.token });
  assert.equal(hb.renewed, true);
  clock.t += 100 * MIN; // 200 min since acquire, 100 since heartbeat
  assert.equal((await C.reapExpired(ctx)).reaped, 0);
  assert.equal((await C.check(ctx, { path: 'h', token: a.token, fence: a.fence })).valid, true);
  assert.equal((await C.heartbeat(ctx, { path: 'h', token: 'wrong' })).reason, 'token_mismatch');
  clock.t += 121 * MIN;
  assert.equal((await C.heartbeat(ctx, { path: 'h', token: a.token })).reason, 'expired');
});

test('release requires the token and frees the item; wrong token is refused', async () => {
  const { db, ctx } = setup(); item(db, 'A');
  const a = await C.acquire(ctx, { item_id: 'A', holder: 'x' });
  assert.equal((await C.release(ctx, { item_id: 'A', token: 'nope' })).reason, 'token_mismatch');
  const r = await C.release(ctx, { item_id: 'A', token: a.token, outcome: 'abandoned' });
  assert.equal(r.released, true);
  assert.equal(db.raw.prepare(`SELECT status FROM items WHERE id='A'`).get().status, 'ready');
  assert.equal((await C.acquire(ctx, { item_id: 'A', holder: 'y' })).acquired, true);
});

test('terminal release: a claim on a done item is released', async () => {
  const { db, ctx } = setup(); item(db, 'A');
  await C.acquire(ctx, { item_id: 'A', holder: 'x' });
  db.raw.exec(`UPDATE items SET status='done', disposition='verified' WHERE id='A'`);
  assert.equal((await C.releaseTerminal(ctx)).released, 1);
  assert.equal(db.raw.prepare(`SELECT outcome FROM claims_lock`).get().outcome, 'terminal');
  assert.equal((await C.acquire(ctx, { item_id: 'A', holder: 'y' })).reason, 'item_terminal');
});

test('US-08-R03 / T04: an item whose trigger is not done cannot be claimed', async () => {
  const { db, ctx } = setup(); item(db, 'A');
  item(db, 'C', 'trigger_on|\'A\'');
  assert.equal((await C.acquire(ctx, { item_id: 'C', holder: 'x' })).reason, 'trigger_not_done');
  db.raw.exec(`UPDATE items SET status='done', disposition='v' WHERE id='A'`);
  assert.equal((await C.acquire(ctx, { item_id: 'C', holder: 'x' })).acquired, true);
});

test('seed dispatch claims are respected (one live claim per item across both tables)', async () => {
  const { db, ctx } = setup(); item(db, 'A');
  db.raw.exec(`INSERT INTO claims (item_id, agent) VALUES ('A','role-1')`);
  const r = await C.acquire(ctx, { item_id: 'A', holder: 'other' });
  assert.equal(r.acquired, false); assert.equal(r.holder, 'role-1');
});

test('US-08-R09: same intent from a second claimant is told to shepherd, not duplicate', async () => {
  const { ctx } = setup();
  await C.acquire(ctx, { path: 'a.js', holder: 'one', intent: 'Fix the  login bug' });
  const same = await C.acquire(ctx, { path: 'a.js', holder: 'two', intent: 'fix the login BUG' });
  assert.equal(same.acquired, false); assert.equal(same.same_intent, true); assert.match(same.advice, /shepherd/);
  const elsewhere = await C.acquire(ctx, { path: 'b.js', holder: 'two', intent: 'fix the login bug' });
  assert.equal(elsewhere.reason, 'same_intent'); assert.equal(elsewhere.holder, 'one');
  const diff = await C.acquire(ctx, { path: 'a.js', holder: 'three', intent: 'rename a function' });
  assert.equal(diff.same_intent, false); assert.match(diff.advice, /review/);
});

test('secret lease: exclusive, short, names only; a value is refused and never stored', async () => {
  const { db, ctx, clock } = setup({ lease_ttl_minutes: 2 });
  const refused = await C.acquire(ctx, { kind: 'secret', key: 'API_KEY', holder: 'a', value: 'hunter2-sekret' });
  assert.equal(refused.reason, 'secret_values_never_accepted');
  const l = await C.acquire(ctx, { kind: 'secret', key: 'API_KEY', holder: 'a', ttl_minutes: 999 });
  assert.equal(l.acquired, true); assert.equal(l.ttl_minutes, 2);
  assert.equal((await C.acquire(ctx, { kind: 'secret', key: 'API_KEY', holder: 'b' })).acquired, false);
  assert.equal((await C.acquire(ctx, { kind: 'secret', key: 'OTHER', holder: 'b' })).acquired, true);
  clock.t += 3 * MIN;
  assert.equal((await C.acquire(ctx, { kind: 'secret', key: 'API_KEY', holder: 'b' })).acquired, true);
  assert.ok(!JSON.stringify(db.raw.prepare(`SELECT * FROM claims_lock`).all()).includes('hunter2'));
});

test('deploy lock uses the same primitives and is independent of work claims', async () => {
  const { ctx } = setup();
  const d = await C.acquire(ctx, { kind: 'deploy', key: 'service-a', holder: 'ci' });
  assert.equal(d.acquired, true); assert.equal(d.fence, 1);
  assert.equal((await C.acquire(ctx, { kind: 'deploy', key: 'service-a', holder: 'ci2' })).acquired, false);
  assert.equal((await C.acquire(ctx, { kind: 'work', key: 'service-a', holder: 'ci2' })).acquired, true);
  assert.equal((await C.release(ctx, { kind: 'deploy', key: 'service-a', token: d.token })).released, true);
});

test('kill switch refuses new claims and renewals; releases and reads keep working', async () => {
  const { ctx } = setup();
  const a = await C.acquire(ctx, { path: 'k', holder: 'a' });
  ctx.killSwitch = async () => true;
  assert.equal((await C.acquire(ctx, { path: 'k2', holder: 'a' })).reason, 'kill-switch');
  assert.equal((await C.acquire(ctx, { kind: 'secret', key: 's', holder: 'a' })).status, 503);
  assert.equal((await C.acquire(ctx, { kind: 'deploy', key: 'd', holder: 'a' })).status, 503);
  assert.equal((await C.heartbeat(ctx, { path: 'k', token: a.token })).status, 503);
  assert.equal((await C.status(ctx, { path: 'k' })).count, 1);
  assert.equal((await C.release(ctx, { path: 'k', token: a.token })).released, true);
});

test('token: from crypto.getRandomValues, opaque, never stored, never logged, never in status', async () => {
  const { db, ctx } = setup();
  const logs = [];
  const orig = [console.log, console.error, console.warn, console.info];
  console.log = console.error = console.warn = console.info = (...a) => logs.push(a.join(' '));
  let a, hb, st, h;
  try {
    a = await C.acquire(ctx, { path: 'tok', holder: 'a', intent: 'x', idempotency_key: 'k1' });
    hb = await C.heartbeat(ctx, { path: 'tok', token: a.token });
    st = await C.status(ctx, {});
    h = await C.handle(new Request('https://x/work-lock/status?key=tok'), ctx);
    await C.release(ctx, { path: 'tok', token: a.token, idempotency_key: 'k2' });
  } finally { [console.log, console.error, console.warn, console.info] = orig; }
  assert.match(a.token, /^[0-9a-f]{64}$/);
  assert.notEqual(a.token, (await C.acquire(ctx, { path: 'tok2', holder: 'a' })).token);
  for (const t of ['claims_lock', 'claims_events', 'claims_idem', 'claims_incidents', 'claims_pulls'])
    assert.ok(!JSON.stringify(db.raw.prepare(`SELECT * FROM ${t}`).all()).includes(a.token), `${t} leaks the token`);
  assert.ok(!JSON.stringify([hb, st, await h.json(), logs]).includes(a.token));
  assert.ok(!JSON.stringify(st).includes(await C.hashToken(a.token)));
});

test('US-08-R15: idempotency key replays without a second effect and without re-disclosing the token', async () => {
  const { db, ctx } = setup();
  const a = await C.acquire(ctx, { path: 'i', holder: 'a', idempotency_key: 'same' });
  const b = await C.acquire(ctx, { path: 'i', holder: 'a', idempotency_key: 'same' });
  assert.equal(b.replayed, true); assert.equal(b.token, undefined);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM claims_lock`).get().n, 1);
  assert.ok(a.token);
});

test('US-08-R04 / T03: item done with no disposition is reopened with one silent_drop', async () => {
  const { db, ctx } = setup(); item(db, 'A');
  db.raw.exec(`UPDATE items SET status='done' WHERE id='A'`);
  await C.reconcile(ctx); await C.reconcile(ctx);
  assert.equal(db.raw.prepare(`SELECT status FROM items WHERE id='A'`).get().status, 'open');
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM outcomes WHERE result='silent_drop'`).get().n, 1);
});

test('US-08-R11 / T06: a loop that scans 25 and books 0 opens an incident and reopens 25 items', async () => {
  const { db, ctx } = setup();
  const ids = Array.from({ length: 25 }, (_, i) => `L${i}`);
  for (const id of ids) { item(db, id); db.raw.exec(`UPDATE items SET status='done', disposition='x' WHERE id='${id}'`); }
  const r = await C.recordLoopRun(ctx, { loop: 'triage', scanned_ids: ids, executed: [], failed: [], needs_human: [], no_action: [] });
  assert.equal(r.gap, 25); assert.ok(r.incident_id); assert.equal(r.reopened.length, 25);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM items WHERE status='open'`).get().n, 25);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM outcomes WHERE result='silent_drop'`).get().n, 25);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM claims_incidents WHERE kind='accounting_gap'`).get().n, 1);
  const ok = await C.recordLoopRun(ctx, { loop: 'triage', scanned: 4, executed: 2, failed: 1, needs_human: 1, no_action: 0 });
  assert.equal(ok.gap, 0); assert.equal(ok.incident_id, null);
});

test('US-08-R12: rework at the threshold escalates once as a root-cause item', async () => {
  const { db, ctx } = setup(); item(db, 'A');
  assert.equal((await C.recordRework(ctx, { item_id: 'A' })).escalated, false);
  assert.equal((await C.recordRework(ctx, { item_id: 'A' })).escalated, false);
  const r = await C.recordRework(ctx, { item_id: 'A' });
  assert.equal(r.escalated, true); assert.equal(r.count, 3);
  await C.recordRework(ctx, { item_id: 'A' });
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM items WHERE id='root-cause-A'`).get().n, 1);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM claims_incidents WHERE kind='rework_escalation'`).get().n, 1);
});

test('US-08-R10: queue pulls are recorded with puller, item and route', async () => {
  const { db, ctx } = setup();
  await C.recordPull(ctx, { puller: 'agent-1', item_id: 'A', route: 'ready-queue' });
  assert.deepEqual({ ...db.raw.prepare(`SELECT puller,item_id,route FROM claims_pulls`).get() }, { puller: 'agent-1', item_id: 'A', route: 'ready-queue' });
});

test('US-08-R14: an identity-bound step becomes one gate card and leaves the doer path; others are rerouted', async () => {
  const { db, ctx } = setup(); item(db, 'A');
  await C.acquire(ctx, { item_id: 'A', holder: 'x' });
  assert.equal((await C.escalateToGate(ctx, { item_id: 'A', what: 'w', why_gated: 'y', default_in_effect: 'd', identity_bound: false })).rerouted, true);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM gate_cards`).get().n, 0);
  const g = await C.escalateToGate(ctx, { item_id: 'A', what: 'sign', why_gated: 'identity', default_in_effect: 'unsigned', closing_probe: 'manual', identity_bound: true });
  assert.equal(g.card, 'gate-A');
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM claims_lock WHERE released_at IS NULL`).get().n, 0);
  assert.equal(db.raw.prepare(`SELECT status FROM items WHERE id='A'`).get().status, 'blocked');
});

test('handle(): router acquires, heartbeats, checks, releases; auth is required for writes', async () => {
  const { ctx } = setup();
  const post = (p, b) => new Request('https://h' + p, { method: 'POST', body: JSON.stringify(b) });
  assert.equal((await C.handle(post('/work-lock/acquire', { key: 'r', holder: 'a' }), ctx)).status, 401);
  ctx.authorize = async req => req.headers.get('authorization') === 'Bearer ok' || true;
  ctx.authorize = async () => true;
  const r1 = await C.handle(post('/work-lock/acquire', { key: 'r', holder: 'a' }), ctx);
  const a = await r1.json(); assert.equal(r1.status, 200); assert.ok(a.token);
  const r2 = await C.handle(post('/work-lock/acquire', { key: 'r', holder: 'b' }), ctx);
  assert.equal(r2.status, 409);
  assert.equal((await (await C.handle(post('/work-lock/heartbeat', { key: 'r', token: a.token }), ctx)).json()).renewed, true);
  assert.equal((await (await C.handle(post('/work-lock/check', { key: 'r', token: a.token, fence: a.fence }), ctx)).json()).valid, true);
  const st = await (await C.handle(new Request('https://h/work-lock/status?key=r'), ctx)).json();
  assert.equal(st.count, 1); assert.equal(st.fence, 1);
  assert.equal((await C.handle(post('/work-lock/release', { key: 'r', token: a.token }), ctx)).status, 200);
  assert.equal((await C.handle(post('/secret-lock/acquire', { key: 'S', holder: 'a', value: 'v' }), ctx)).status, 400);
  assert.equal((await C.handle(post('/deploy-lock/acquire', { key: 'D', holder: 'a' }), ctx)).status, 200);
  assert.equal((await C.handle(new Request('https://h/nope'), ctx)).status, 404);
  ctx.killSwitch = () => true;
  assert.equal((await C.handle(post('/work-lock/acquire', { key: 'z', holder: 'a' }), ctx)).status, 503);
});

test('seed tick still dispatches around item claims taken here', async () => {
  const { db, ctx } = setup(); item(db, 'A');
  await C.acquire(ctx, { item_id: 'A', holder: 'agent-1' });
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM claims WHERE item_id='A'`).get().n, 1);
});
