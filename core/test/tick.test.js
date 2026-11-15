// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './d1shim.js';
import { runTick, STEP_ORDER, reliability } from '../src/tick.js';
import { readFileSync } from 'node:fs';

const policy = JSON.parse(readFileSync(new URL('../../autonomy/policy.json', import.meta.url), 'utf8'));
const config = { org_slug: 't', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy };
const T0 = Date.parse('2026-11-10T00:00:00Z');

function seed(db) {
  db.raw.exec(`INSERT INTO roles (id, role, tick_every, model) VALUES ('staff-1','staff',1,'m'), ('op-1','operations',1,'m');
    INSERT INTO items (id,title,owner_role,done_check,priority,status) VALUES ('A','a','staff','x',10,'open'), ('B','b','staff','x',20,'open');
    INSERT INTO items (id,title,owner_role,done_check,trigger_on,status) VALUES ('C','c','staff','x','A','open');`);
}

test('a tick runs every step and dispatches in priority order', async () => {
  const db = makeDb(); seed(db);
  const r = await runTick(db, { config, now: T0 });
  assert.equal(r.completed, STEP_ORDER.length);
  assert.deepEqual(r.errors, []);
  const claims = db.raw.prepare('SELECT item_id FROM claims').all().map(x => x.item_id);
  assert.deepEqual(claims, ['A']);
  assert.equal(db.raw.prepare("SELECT status FROM items WHERE id='C'").get().status, 'open'); // trigger not done
  assert.match(r.report, /^Happened:/); assert.match(r.report, /Open:/);
});

test('a failing step never kills the tick and becomes a backlog item', async () => {
  const db = makeDb(); seed(db);
  db.raw.exec('DROP TABLE predictions');
  const r = await runTick(db, { config, now: T0 });
  assert.equal(r.completed, STEP_ORDER.length - 1);
  assert.equal(r.errors.length, 1);
  const item = db.raw.prepare("SELECT owner_role, priority FROM items WHERE id LIKE 'TICKFAIL-score_predictions%'").get();
  assert.equal(item.owner_role, 'operations'); assert.equal(item.priority, 0);
});

test('items that left the active set without a disposition are reopened and counted as silent drops', async () => {
  const db = makeDb(); seed(db);
  db.raw.exec("UPDATE items SET status='done' WHERE id='B'");
  await runTick(db, { config, now: T0 });
  assert.notEqual(db.raw.prepare("SELECT status FROM items WHERE id='B'").get().status, 'done');
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM outcomes WHERE result='silent_drop'").get().n, 1);
});

test('stale claims are released', async () => {
  const db = makeDb(); seed(db);
  await runTick(db, { config, now: T0 });
  await runTick(db, { config, now: T0 + 3 * 3600e3 });
  const dispatches = db.raw.prepare('SELECT COUNT(*) AS n FROM dispatches').get().n;
  assert.ok(dispatches >= 2); // item A was released and re-dispatched
});

test('gate cards close when their probe shows the owner step is done', async () => {
  const db = makeDb(); seed(db);
  db.raw.exec("INSERT INTO gate_cards (id,what,why_gated,default_in_effect,closing_probe) VALUES ('G','set key','owner','dry run','env:CLOUDFLARE_API_TOKEN')");
  await runTick(db, { config, now: T0, env: {} });
  assert.equal(db.raw.prepare("SELECT status FROM gate_cards WHERE id='G'").get().status, 'open');
  await runTick(db, { config, now: T0 + 600e3, env: { CLOUDFLARE_API_TOKEN: true } });
  assert.equal(db.raw.prepare("SELECT status FROM gate_cards WHERE id='G'").get().status, 'closed');
});

test('predictions are scored against built-in metrics', async () => {
  const db = makeDb(); seed(db);
  db.raw.exec("INSERT INTO predictions (id,metric,op,target,due_at) VALUES ('P','open_gate_cards','<=',0,'2026-11-09 00:00:00')");
  await runTick(db, { config, now: T0 });
  assert.equal(db.raw.prepare("SELECT verdict FROM predictions WHERE id='P'").get().verdict, 'hit');
});

test('trust promotes only inside the surface ceiling and only by opening a PR item', async () => {
  const db = makeDb(); seed(db);
  for (let i = 0; i < 12; i++) {
    db.raw.exec("INSERT INTO outcomes (surface,action_class,result) VALUES ('repo','branch_commit_push','verified'), ('money','estimate_cost','verified')");
  }
  await runTick(db, { config, now: T0 });
  const ladder = db.raw.prepare("SELECT id FROM items WHERE kind='ladder'").all().map(x => x.id);
  assert.ok(ladder.some(id => id.startsWith('LADDER-repo-branch_commit_push-autonomous')));
  // money is capped at propose -> assisted; it starts at observed so it may reach assisted, never beyond
  assert.ok(ladder.some(id => id.startsWith('LADDER-money-estimate_cost-assisted')));
  // the ledger itself never changes rung: only a reviewed policy PR does
  assert.equal(db.raw.prepare("SELECT rung FROM trust_ledger WHERE surface='repo'").get().rung, 'delegated');
});

test('a hidden failure demotes', async () => {
  const db = makeDb(); seed(db);
  db.raw.exec("INSERT INTO trust_ledger (surface,action_class,rung,reliability) VALUES ('repo','merge_pr_green','autonomous',0.9)");
  db.raw.exec("INSERT INTO outcomes (surface,action_class,result) VALUES ('repo','merge_pr_green','hidden_failure')");
  await runTick(db, { config, now: T0 });
  assert.ok(db.raw.prepare("SELECT id FROM items WHERE id LIKE 'LADDER-repo-merge_pr_green-delegated'").get());
});

test('reliability starts at the baseline and moves with outcomes', () => {
  assert.equal(reliability(0, 0, policy.trust), 0.5);
  assert.ok(reliability(10, 10, policy.trust) > 0.9);
});

test('an item addressed to one role instance is dispatched to that instance, not left ready for ever', async () => {
  const db = makeDb();
  db.raw.exec(`INSERT INTO roles (id, role, project, tick_every, model) VALUES ('product-manager-1','product-manager','OUT-1',1,'m'), ('product-manager-2','product-manager','OUT-2',1,'m');
    INSERT INTO items (id,title,owner_role,done_check,priority,status) VALUES ('P2','p','product-manager-2','x',10,'ready');`);
  await runTick(db, { config, now: T0 });
  const claim = db.raw.prepare("SELECT agent FROM claims WHERE item_id='P2'").get();
  assert.ok(claim, 'the item was claimed'); assert.equal(claim.agent, 'product-manager-2');
});

test('issue #173: a claim released with no work is recorded, and the item is parked after max_unworked_releases', async () => {
  const db = makeDb(); seed(db);
  const cfg = { ...config, max_unworked_releases: 2 };
  await runTick(db, { config: cfg, now: T0 });
  await runTick(db, { config: cfg, now: T0 + 3 * 3600e3 });
  await runTick(db, { config: cfg, now: T0 + 6 * 3600e3 });
  const unworked = db.raw.prepare("SELECT COUNT(*) AS n FROM outcomes WHERE surface='dispatch' AND result='unworked' AND item_id='A'").get().n;
  assert.equal(unworked, 2);
  const a = db.raw.prepare("SELECT status, blocker, disposition FROM items WHERE id='A'").get();
  assert.equal(a.status, 'blocked');
  assert.match(a.disposition, /^parked: dispatched 2 times, never worked/);
  await runTick(db, { config: cfg, now: T0 + 9 * 3600e3 });
  assert.equal(db.raw.prepare("SELECT status FROM items WHERE id='A'").get().status, 'blocked', 'a parked item is not claimed again');
});

test('issue #173: a claim that was heartbeated is released without an unworked outcome', async () => {
  const db = makeDb(); seed(db);
  await runTick(db, { config, now: T0 });
  db.raw.exec("UPDATE claims SET heartbeat_at = datetime(claimed_at, '+1 minute')");
  await runTick(db, { config, now: T0 + 3 * 3600e3 });
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM outcomes WHERE result='unworked'").get().n, 0);
});

test('issue #173 execute: a dispatched item whose probe passes ends done with evidence in the same tick', async () => {
  const db = makeDb();
  db.raw.exec(`INSERT INTO roles (id, role, tick_every, model) VALUES ('op-1','operations',1,'m');
    INSERT INTO items (id,title,owner_role,done_check,closing_probe,status) VALUES ('DEP','dep','nobody','x',NULL,'done');
    UPDATE items SET disposition='done: seeded' WHERE id='DEP';
    INSERT INTO items (id,title,owner_role,done_check,closing_probe,priority,status) VALUES ('P1','p','operations','dep is done','item_done:DEP',1,'ready');`);
  const r = await runTick(db, { config, now: T0 });
  assert.deepEqual(r.errors, []);
  const it = db.raw.prepare("SELECT status, disposition FROM items WHERE id='P1'").get();
  assert.equal(it.status, 'done'); assert.match(it.disposition, /done by tick-doer in tick 1: item DEP is done/);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM claims").get().n, 0);
  const o = db.raw.prepare("SELECT agent, result, evidence FROM outcomes WHERE item_id='P1'").get();
  assert.deepEqual([o.agent, o.result], ['tick-doer', 'verified']);
  assert.equal(db.raw.prepare("SELECT status FROM dispatches WHERE item_id='P1'").get().status, 'done');
  assert.match(r.report, /executed: 1 done \(0 from parked\), 0 parked on a probe, 0 left for an executor/);
});

test('issue #173 execute: a failing probe parks the item with a reason, and it closes by itself when the probe passes', async () => {
  const db = makeDb();
  db.raw.exec(`INSERT INTO roles (id, role, tick_every, model) VALUES ('op-1','operations',1,'m');
    INSERT INTO items (id,title,owner_role,done_check,closing_probe,priority,status) VALUES ('E1','needs a setting','operations','setting present','env:SOME_SETTING',1,'ready'),
      ('S1','sql probe','operations','two ticks ran','SELECT COUNT(*) FROM tick_runs WHERE id >= 2',2,'ready');`);
  await runTick(db, { config, now: T0 });
  const e1 = db.raw.prepare("SELECT status, blocker, disposition FROM items WHERE id='E1'").get();
  assert.equal(e1.status, 'blocked');
  assert.match(e1.blocker, /^waiting on probe: env:SOME_SETTING \(setting SOME_SETTING is absent\)/);
  assert.match(e1.disposition, /parked by tick-doer/);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM claims").get().n, 0, 'a parked item holds no claim');
  // never re-dispatched while parked, never counted as released unworked
  await runTick(db, { config, now: T0 + 3 * 3600e3 });
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM dispatches WHERE item_id='E1'").get().n, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM outcomes WHERE result='unworked'").get().n, 0);
  assert.equal(db.raw.prepare("SELECT status FROM items WHERE id='S1'").get().status, 'done', 'the SELECT probe passed on tick 2');
  const r = await runTick(db, { config, env: { SOME_SETTING: true }, now: T0 + 4 * 3600e3 });
  assert.equal(db.raw.prepare("SELECT status FROM items WHERE id='E1'").get().status, 'done');
  assert.match(r.report, /\(1 from parked\)/);
});

test('issue #173 execute: an item with no machine-readable probe keeps its claim for an outside executor; a worked claim is not touched', async () => {
  const db = makeDb(); seed(db);
  db.raw.exec(`INSERT INTO items (id,title,owner_role,done_check,closing_probe,priority,status) VALUES ('W1','worked','operations','x','env:NOPE',1,'ready')`);
  const r = await runTick(db, { config: { ...config, execute_max_items: 0 }, now: T0 }); // nothing executed this tick: both stay claimed
  assert.match(r.report, /0 left for an executor/);
  db.raw.exec(`UPDATE claims SET heartbeat_at='2026-11-10 00:30:00' WHERE item_id='W1'`); // an executor is working it
  const r2 = await runTick(db, { config, now: T0 + 60e3 });
  assert.equal(db.raw.prepare("SELECT status FROM items WHERE id='W1'").get().status, 'claimed');
  assert.equal(db.raw.prepare("SELECT status FROM items WHERE id='A'").get().status, 'claimed');
  assert.match(r2.report, /0 parked on a probe, 2 left for an executor/); // A and B wait for an executor; W1 is being worked
});

test('issue #173 execute: a TICKFAIL item closes when a later tick completes the step, and an unreadable SELECT probe parks instead of throwing', async () => {
  const db = makeDb();
  db.raw.exec(`INSERT INTO roles (id, role, tick_every, model) VALUES ('op-1','operations',1,'m');
    INSERT INTO items (id,title,kind,owner_role,done_check,priority,status,created_at) VALUES ('TICKFAIL-score_predictions-2026-11-09T23','failed','fix','operations','next tick completes step score_predictions',0,'ready','2026-11-09 23:00:00');
    INSERT INTO tick_runs (started_at, finished_at, steps_completed, steps_total, errors) VALUES ('2026-11-09 23:10:00','2026-11-09 23:10:00',7,8,'["score_predictions: boom"]'), ('2026-11-09 23:20:00','2026-11-09 23:20:00',8,8,NULL);
    INSERT INTO items (id,title,owner_role,done_check,closing_probe,priority,status) VALUES ('BADSQL','bad','operations','x','select n from no_such_table',1,'ready');`);
  const r = await runTick(db, { config: { ...config, max_wip_per_role: 5 }, now: T0 });
  assert.deepEqual(r.errors, []);
  const t = db.raw.prepare("SELECT status, disposition FROM items WHERE id LIKE 'TICKFAIL-%'").get();
  assert.equal(t.status, 'done'); assert.match(t.disposition, /tick 2 completed step score_predictions/);
  await runTick(db, { config, now: T0 + 60e3 });
  const b = db.raw.prepare("SELECT status, blocker FROM items WHERE id='BADSQL'").get();
  assert.equal(b.status, 'blocked'); assert.match(b.blocker, /probe could not run/);
});
