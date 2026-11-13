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
