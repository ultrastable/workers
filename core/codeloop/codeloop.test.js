// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { parseTask, mergeDecision, mergeRun, sweep, cfg } from './index.js';

const d = rel => fileURLToPath(new URL(rel, import.meta.url));
const mk = (extra = {}) => ({ db: makeDb([d('../runner/migrations/'), d('./migrations/')]), now: () => Date.parse('2026-11-11T10:00:00Z'), config: {}, rung: async () => 'autonomous', ...extra });
async function seed(ctx, state = 'approved') {
  await ctx.db.prepare("INSERT INTO items (id,title,owner_role,done_check,status) VALUES ('I-1','t','staff','x','claimed')").run();
  await ctx.db.prepare('INSERT INTO runner_runs (item_id,state,pr_number,created_at,updated_at) VALUES (?,?,?,?,?)').bind('I-1', state, 7, 'a', 'a').run();
}

test('parseTask reads paths, test and base; absent or pathless returns null', () => {
  assert.deepEqual(parseTask('x\ncode-task: paths=a.js, b.js; test=npm test; base=main'), { paths: ['a.js', 'b.js'], test: 'npm test', base: 'main' });
  assert.equal(parseTask('no task here'), null);
  assert.equal(parseTask('code-task: test=x'), null);
});

test('merge gate refuses protected paths, low rung, unapproved runs, kill switch', () => {
  const c = cfg({ config: { protected_paths: ['autonomy'] } });
  const run = { state: 'approved', pr_number: 1 };
  assert.equal(mergeDecision({ run, files: ['autonomy/policy.json'], rung: 'autonomous' }, c).ok, false);
  assert.match(mergeDecision({ run, files: ['a.js'], rung: 'assisted' }, c).reason, /rung_below/);
  assert.equal(mergeDecision({ run: { ...run, state: 'checks_failed' }, rung: 'autonomous' }, c).reason, 'not_approved');
  assert.equal(mergeDecision({ run, rung: 'autonomous', killed: true }, c).reason, 'kill_switch');
  assert.equal(mergeDecision({ run, files: ['a.js'], rung: 'autonomous' }, c).ok, true);
});

test('no single route: the first host fails, the second merges, item closes with disposition', async () => {
  const hosts = [{ name: 'host-a', merge: async () => { throw new Error('503'); } }, { name: 'host-b', merge: async () => ({ merged: true }) }];
  const ctx = mk({ hosts }); await seed(ctx);
  const r = await mergeRun(ctx, 1, { files: ['a.js'] });
  assert.deepEqual([r.merged, r.host], [true, 'host-b']);
  const it = await ctx.db.prepare("SELECT status, disposition FROM items WHERE id='I-1'").first();
  assert.equal(it.status, 'done'); assert.match(it.disposition, /host-b/);
  assert.equal((await sweep(ctx)).length, 0, 'a merged run is not merged twice');
});

test('all hosts failing is recorded, not swallowed', async () => {
  const ctx = mk({ hosts: [{ name: 'a', merge: async () => ({ merged: false, reason: 'conflict' }) }, { name: 'b', merge: async () => { throw new Error('down'); } }] }); await seed(ctx);
  const r = await mergeRun(ctx, 1, { files: [] });
  assert.equal(r.reason, 'all_hosts_failed'); assert.equal(r.attempts.length, 2);
  const m = await ctx.db.prepare('SELECT decision FROM codeloop_merges').first();
  assert.equal(m.decision, 'failed');
  assert.equal((await ctx.db.prepare("SELECT status FROM items WHERE id='I-1'").first()).status, 'claimed');
});
