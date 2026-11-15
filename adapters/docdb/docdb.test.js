// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// US-SPEC-14 section 4, document database: the rewritten steps give the same result as the SQL steps, claims are unique under
// contention (US-14-R11), and the L1 data-model tests that touch these steps are re-run (US-01-T02, US-01-T03).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb } from '../../core/_shared/testdb.js';
import { STEPS as SQL_STEPS } from '../../core/src/tick.js';
import { memoryDocStore, claim, STEPS, runDocTick, importFromStore, COLLECTIONS } from './index.js';

const policy = JSON.parse(readFileSync(new URL('../../autonomy/policy.json', import.meta.url), 'utf8'));
const config = { claim_ttl_minutes: 120, max_wip_per_role: 2, plus_share: 0.2, policy };
const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);
const NOW = '2026-11-15 12:00:00';
const newItem = (o = {}) => ({ title: 't', kind: 'work', project: null, owner_role: 'staff', trigger_on: null, done_check: 'x', closing_probe: null, priority: 10, status: 'ready', disposition: null, blocker: null, surface: null, action_class: null, created_at: NOW, updated_at: NOW, ...o });
const surface = Object.keys(policy.surfaces)[0];

test('the store keeps one collection per L1 table and refuses a query that has no declared index', async () => {
  assert.equal(COLLECTIONS.length, 11);
  const s = memoryDocStore();
  await s.set('items', 'A', newItem());
  assert.equal((await s.query('items', { where: { status: 'ready', owner_role: 'staff' } })).length, 1);
  await assert.rejects(() => s.query('items', { where: { title: 't' } }), /no index on items/);
  const got = await s.get('items', 'A'); got.title = 'changed';
  assert.equal((await s.get('items', 'A')).title, 't', 'a caller cannot change a stored document through a returned copy');
});

test('US-01-T02 and US-01-R02 on a document store: a second claim for one item is rejected by the create-only write', async () => {
  const s = memoryDocStore();
  await s.set('items', 'A', newItem());
  assert.deepEqual(await claim(s, 'A', 'staff-1', NOW), { ok: true });
  assert.deepEqual(await claim(s, 'A', 'staff-2', NOW), { ok: false, reason: 'already_claimed' });
  assert.equal(await s.create('claims', 'A', { agent: 'staff-3' }), false);
  assert.equal((await s.get('claims', 'A')).agent, 'staff-1');
  assert.equal((await s.get('items', 'A')).status, 'claimed');
  assert.deepEqual(await claim(s, 'NOPE', 'staff-1', NOW), { ok: false, reason: 'no_such_item' });
});

test('US-14-R11: under contention exactly one of fifty concurrent claimers wins; a read-then-write claim would not be safe', async () => {
  const s = memoryDocStore();
  await s.set('items', 'A', newItem());
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => claim(s, 'A', `agent-${i}`, NOW)));
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(s._size('claims'), 1);
  // the same store, claimed the unsafe way (read, then write): several callers believe they hold the claim
  const naive = async agent => { if (await s.get('claims', 'B')) return false; await s.set('claims', 'B', { agent }); return true; };
  const unsafe = await Promise.all(Array.from({ length: 10 }, (_, i) => naive(`agent-${i}`)));
  assert.ok(unsafe.filter(Boolean).length > 1, 'the contention in this test is real');
});

test('US-14-R11: five role instances dispatching at once never claim one item twice and never exceed their limit', async () => {
  const s = memoryDocStore();
  for (let i = 0; i < 5; i++) await s.set('roles', `staff-${i}`, { role: 'staff', project: null, tick_every: 1, model: 'small', last_tick_at: null });
  for (let i = 0; i < 6; i++) await s.set('items', `I${i}`, newItem({ priority: i }));
  const ctxs = Array.from({ length: 5 }, () => ({ config, nowIso: NOW, tickId: 1, notes: [] }));
  await Promise.all(ctxs.map(c => STEPS.dispatch(s, c)));
  const claims = await s.scan('claims');
  assert.equal(claims.length, 6, 'every ready item was claimed');
  assert.equal(new Set(claims.map(c => c.key)).size, 6);
  const per = {}; for (const c of claims) per[c.agent] = (per[c.agent] || 0) + 1;
  assert.equal((await s.scan('dispatches')).length, 6);
  assert.equal((await s.query('items', { where: { status: 'ready' } })).length, 0);
  assert.ok(Object.values(per).every(n => n <= 6));
});

test('a transaction is all-or-nothing: a throw restores the store', async () => {
  const s = memoryDocStore();
  await s.set('items', 'A', newItem());
  await assert.rejects(() => s.transaction(tx => { tx.patch('items', 'A', { status: 'done' }); tx.add('outcomes', { item_id: 'A' }); throw new Error('boom'); }), /boom/);
  assert.equal((await s.get('items', 'A')).status, 'ready'); assert.equal(s._size('outcomes'), 0);
  assert.equal(await s.transaction(tx => tx.get('items', 'A').status), 'ready', 'the store still works after a failed transaction');
});

test('US-01-T03 on a document store: an item done with no disposition is reopened and a silent_drop outcome is written', async () => {
  const s = memoryDocStore();
  await s.set('items', 'GONE', newItem({ status: 'done', disposition: '' }));
  await s.set('items', 'FINE', newItem({ status: 'done', disposition: 'done with evidence' }));
  await s.set('items', 'NEXT', newItem({ status: 'open', trigger_on: 'FINE' }));
  await s.set('items', 'WAITS', newItem({ status: 'open', trigger_on: 'GONE' }));
  const r = await runDocTick(s, { config, now: T0, tickId: 1 });
  assert.equal(r.completed, 3); assert.deepEqual(r.errors, []);
  assert.notEqual((await s.get('items', 'GONE')).status, 'done');
  assert.equal((await s.get('items', 'FINE')).status, 'done');
  assert.equal((await s.get('items', 'NEXT')).status, 'ready');
  assert.equal((await s.get('items', 'WAITS')).status, 'open');
  const drops = (await s.scan('outcomes')).filter(o => o.result === 'silent_drop');
  assert.deepEqual(drops.map(o => o.item_id), ['GONE']);
  const run = (await s.scan('tick_runs'))[0];
  assert.equal(run.steps_completed, 3); assert.equal(run.finished_at, NOW);
});

test('parity: reconcile, trust and dispatch on the document store end in the same state as the SQL steps on the same data', async () => {
  const db = makeDb();
  db.raw.exec(`INSERT INTO roles (id, role, project, tick_every, model) VALUES ('staff-1','staff',NULL,1,'m'), ('staff-2','staff','p2',1,'m'), ('ops-1','operations',NULL,2,'m');
    INSERT INTO items (id,title,owner_role,done_check,priority,status,created_at,updated_at) VALUES ('A','a','staff','x',10,'open','${NOW}','${NOW}'),('B','b','staff','x',5,'open','${NOW}','${NOW}'),('E','e','staff-2','x',50,'open','${NOW}','${NOW}');
    INSERT INTO items (id,title,owner_role,done_check,priority,status,project,created_at,updated_at) VALUES ('P2','p','staff','x',1,'open','p2','${NOW}','${NOW}');
    INSERT INTO items (id,title,owner_role,done_check,trigger_on,status,created_at,updated_at) VALUES ('C','c','staff','x','D','open','${NOW}','${NOW}'),('O','o','operations','x',NULL,'open','${NOW}','${NOW}');
    INSERT INTO items (id,title,owner_role,done_check,status,disposition,created_at,updated_at) VALUES ('D','d','staff','x','done','shipped','${NOW}','${NOW}'),('X','x','staff','x','cancelled','','${NOW}','${NOW}');`);
  const ins = db.raw.prepare(`INSERT INTO outcomes (item_id, agent, surface, action_class, result, evidence, at) VALUES ('D','staff-1',?,?,?,'e','${NOW}')`);
  for (let i = 0; i < 12; i++) ins.run(surface, 'merge', 'verified');
  for (let i = 0; i < 4; i++) ins.run(surface, 'deploy', i < 3 ? 'failed' : 'hidden_failure');
  db.raw.prepare(`INSERT INTO trust_ledger (surface, action_class, rung, reliability, outcomes, updated_at) VALUES (?, 'deploy', 'assisted', 0.5, 0, '${NOW}')`).run(surface);
  const store = memoryDocStore();
  await importFromStore(db, store);

  const ctx = () => ({ config, now: T0, nowIso: NOW, tickId: 1, notes: [], errors: [], dispatched: 0 });
  const a = ctx(); for (const n of ['reconcile', 'accrue_trust', 'dispatch']) await SQL_STEPS[n](db, a);
  const b = ctx(); for (const n of ['reconcile', 'accrue_trust', 'dispatch']) await STEPS[n](store, b);

  const sqlItems = Object.fromEntries(db.raw.prepare(`SELECT id, status, kind, priority, owner_role FROM items`).all().map(r => [r.id, { ...r, id: undefined }]));
  const docItems = Object.fromEntries((await store.scan('items')).map(r => [r.key, { id: undefined, status: r.status, kind: r.kind, priority: r.priority, owner_role: r.owner_role }]));
  assert.deepEqual(docItems, sqlItems);
  assert.ok(Object.keys(sqlItems).some(k => k.startsWith('LADDER-')), 'the fixture crosses a ladder threshold');
  const sqlClaims = Object.fromEntries(db.raw.prepare(`SELECT item_id, agent FROM claims`).all().map(r => [r.item_id, r.agent]));
  const docClaims = Object.fromEntries((await store.scan('claims')).map(r => [r.key, r.agent]));
  assert.deepEqual(docClaims, sqlClaims); assert.ok(Object.keys(sqlClaims).length >= 2);
  const sqlTrust = db.raw.prepare(`SELECT surface, action_class, rung, reliability, outcomes FROM trust_ledger ORDER BY action_class`).all().map(r => ({ ...r }));
  const docTrust = (await store.scan('trust_ledger')).map(({ surface: s, action_class, rung, reliability, outcomes }) => ({ surface: s, action_class, rung, reliability, outcomes })).sort((x, y) => x.action_class.localeCompare(y.action_class));
  assert.deepEqual(docTrust, sqlTrust);
  assert.equal((await store.scan('outcomes')).filter(o => o.result === 'silent_drop').length, db.raw.prepare(`SELECT COUNT(*) AS n FROM outcomes WHERE result='silent_drop'`).get().n);
  assert.equal(b.dispatched, a.dispatched);
  assert.deepEqual(b.notes, a.notes);
});
