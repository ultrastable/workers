// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { mirror, unplaced, stuck, rollup, steward, hygiene } from './index.js';

const mig = fileURLToPath(new URL('./migrations/', import.meta.url));
const add = (db, id, extra = {}) => db.prepare("INSERT INTO items (id,title,kind,owner_role,done_check,closing_probe,priority,status) VALUES (?,?,'work',?,?,?,50,?)")
  .bind(id, 'T ' + id, 'operations', extra.done ?? 'done', extra.probe ?? 'probe', extra.status ?? 'open').run();
const sink = (name, fail = () => false) => { const calls = []; return { name, calls, upsert: async (it, prev) => { calls.push([it.id, prev]); if (fail(it)) throw new Error(name + ' down'); return { ref: prev || name + '-' + it.id }; } }; };
const mk = sinks => ({ db: makeDb([mig]), now: () => Date.parse('2026-06-10T12:00:00Z'), config: {}, sinks });

test('every item goes to every sink; an unchanged item is skipped on the next sweep', async () => {
  const a = sink('a'), b = sink('b'), ctx = mk([a, b]);
  await add(ctx.db, 'I-1'); await add(ctx.db, 'I-2');
  const r1 = await mirror(ctx);
  assert.deepEqual([r1.synced, r1.failed, r1.skipped], [4, 0, 0]);
  const r2 = await mirror(ctx);
  assert.deepEqual([r2.synced, r2.skipped], [0, 4]);
  assert.equal(a.calls.length, 2);
});

test('a failing sink does not block the others, and is reported by stuck()', async () => {
  const bad = sink('bad', () => true), good = sink('good'), ctx = mk([bad, good]);
  await add(ctx.db, 'I-1');
  const r = await mirror(ctx);
  assert.deepEqual([r.synced, r.failed], [1, 1]);
  assert.deepEqual((await stuck(ctx)).map(s => [s.sink, s.last_error]), [['bad', 'bad down']]);
  assert.deepEqual(await unplaced(ctx), [{ item_id: 'I-1', sinks: ['bad'] }]);
});

test('hygiene flags items missing owner, done check or closing probe', async () => {
  assert.deepEqual(hygiene({ owner_role: 'x', done_check: ' ', closing_probe: '' }), ['done_check', 'closing_probe']);
  const ctx = mk([sink('a')]); await add(ctx.db, 'I-1', { probe: ' ' });
  assert.deepEqual((await mirror(ctx)).flagged, [{ id: 'I-1', missing: ['closing_probe'] }]);
});

test('an edited item is pushed again with its previous ref', async () => {
  const a = sink('a'), ctx = mk([a]); await add(ctx.db, 'I-1'); await mirror(ctx);
  await ctx.db.prepare("UPDATE items SET status='done' WHERE id='I-1'").run();
  await mirror(ctx);
  assert.deepEqual(a.calls[1], ['I-1', 'a-I-1']);
});

test('steward(): files one deduplicated item per stuck mirror and records the run', async () => {
  const ctx = mk([sink('bad', () => true)]); await add(ctx.db, 'I-1');
  const r1 = await steward(ctx), r2 = await steward(ctx);
  assert.deepEqual([r1.filed, r2.filed, r1.stuck.length], [1, 0, 1]);
  assert.equal((await ctx.db.prepare('SELECT COUNT(*) n FROM steward_runs').first()).n, 2);
  assert.equal((await ctx.db.prepare("SELECT status FROM items WHERE id='STW-I-1-bad'").first()).status, 'open');
});

test('closed items are not unplaced; rollup counts by status and owner', async () => {
  const ctx = mk([sink('a')]); await add(ctx.db, 'I-1', { status: 'done' }); await add(ctx.db, 'I-2', { done: '' });
  assert.deepEqual((await unplaced(ctx)).map(u => u.item_id), ['I-2']);
  const r = await rollup(ctx);
  assert.deepEqual([r.total, r.by_status.done, r.by_status.open, r.by_owner.operations, r.malformed], [2, 1, 1, 2, 1]);
});
