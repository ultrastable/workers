// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { enqueue, runDue, watchOwnerSteps } from './index.js';

const mig = fileURLToPath(new URL('./migrations/', import.meta.url));
let T = Date.parse('2026-11-11T10:00:00Z');
const mk = (handlers, extra = {}) => ({ db: makeDb([mig]), now: () => T, config: {}, handlers, ...extra });

test('no single route: first handler throws, second completes the task', async () => {
  const ctx = mk({ sync: [async () => { throw new Error('primary down'); }, async () => {}] });
  await enqueue(ctx, 'sync');
  assert.deepEqual(await runDue(ctx), { done: 1, retried: 0, failed: 0 });
  assert.equal((await ctx.db.prepare('SELECT handler FROM tasks_queue').first()).handler, 'route-1');
});
test('a task whose routes all fail retries with backoff, then becomes a work item', async () => {
  const ctx = mk({ x: [async () => { throw new Error('boom'); }] }); T = Date.parse('2026-11-11T10:00:00Z');
  await enqueue(ctx, 'x');
  for (let i = 0; i < 4; i++) { await runDue(ctx); T += 3 * 3600000; }
  assert.equal((await ctx.db.prepare('SELECT status FROM tasks_queue').first()).status, 'failed');
  assert.equal((await ctx.db.prepare("SELECT COUNT(*) n FROM items WHERE id LIKE 'TASK-%'").first()).n, 1);
  const none = mk({}); await enqueue(none, 'unknown'); await runDue(none);
  assert.equal((await none.db.prepare('SELECT last_error FROM tasks_queue').first()).last_error, 'no_handler');
});
test('owner-step watch closes probed cards and escalates stale ones once', async () => {
  const ctx = mk({}, { probe: async g => g.id === 'g1' });
  const ins = (id, ms) => ctx.db.prepare("INSERT INTO gate_cards (id, what, why_gated, default_in_effect, closing_probe) VALUES (?,?,?,?,?)").bind(id, 'what ' + id, 'w', 'd', 'manual').run();
  await ins('g1'); await ins('g2');
  T = Date.parse('2026-11-11T10:00:00Z');
  assert.deepEqual(await watchOwnerSteps(ctx), { closed: 1, escalated: 0 });
  T += 25 * 3600000;
  assert.deepEqual(await watchOwnerSteps(ctx), { closed: 0, escalated: 1 });
  assert.deepEqual(await watchOwnerSteps(ctx), { closed: 0, escalated: 0 }, 'escalates once');
});
