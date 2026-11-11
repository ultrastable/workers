// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { recordCall, sweep, evaluate, cfg } from './index.js';

const mig = fileURLToPath(new URL('./migrations/', import.meta.url));
const mk = (extra = {}) => ({ db: makeDb([mig]), now: () => Date.parse('2026-06-10T12:00:00Z'), config: {}, ...extra });
const feed = async (ctx, n, over) => { for (let i = 0; i < n; i++) await recordCall(ctx, { source: 's1', purpose: 'p1', ...over(i) }); };

test('W-ERR and W-RATE fire on an erroring purpose and file one item each', async () => {
  const ctx = mk({ config: { err_cost: 5 } });
  await feed(ctx, 120, i => ({ ok: i % 5 !== 0, cost: 1, outTokens: 10 }));
  const r = await sweep(ctx);
  assert.equal(r.filed, 2);
  const items = (await ctx.db.prepare("SELECT id, status, owner_role FROM items WHERE id LIKE 'YLD-%'").all()).results;
  assert.equal(items.length, 2);
  assert.ok(items.every(x => x.status === 'open' && x.owner_role === 'operations'));
});

test('W-META fires for unmetered calls; a metered purpose does not', () => {
  const c = cfg({});
  const f = evaluate([{ source: 'a', purpose: 'x', calls: 150, errors: 0, out_tokens: 0, cost: 0 }, { source: 'a', purpose: 'y', calls: 150, errors: 0, out_tokens: 9, cost: 2 }], c);
  assert.deepEqual(f.map(x => x.rule), ['W-META']);
});

test('W-YIELD compares cost per output with the previous window', () => {
  const f = evaluate([], cfg({}), { cost: 30, outputs: 10, prevCost: 20, prevOutputs: 10 });
  assert.equal(f[0].rule, 'W-YIELD');
  assert.deepEqual(evaluate([], cfg({}), { cost: 20, outputs: 10, prevCost: 20, prevOutputs: 10 }), []);
});

test('lifecycle: re-fire keeps one item, three clean runs close it, recurrence reopens it', async () => {
  const ctx = mk({ config: { rate_min_calls: 10, err_cost: 1e9, clean_runs_to_close: 3 } });
  await feed(ctx, 20, i => ({ ok: i % 2, cost: 1, outTokens: 1 }));
  assert.equal((await sweep(ctx)).filed, 1);
  assert.equal((await sweep(ctx)).filed, 0);
  await ctx.db.prepare('DELETE FROM yield_calls').run();
  for (let i = 0; i < 3; i++) await sweep(ctx);
  assert.equal((await ctx.db.prepare("SELECT status FROM items WHERE id LIKE 'YLD-%'").first()).status, 'done');
  await feed(ctx, 20, i => ({ ok: i % 2, cost: 1, outTokens: 1 }));
  await sweep(ctx);
  assert.equal((await ctx.db.prepare("SELECT status FROM items WHERE id LIKE 'YLD-%'").first()).status, 'open');
});

test('new items per sweep are capped', async () => {
  const ctx = mk({ config: { max_new_items: 1, rate_min_calls: 5, err_cost: 1e9 } });
  for (const s of ['a', 'b', 'c']) for (let i = 0; i < 10; i++) await recordCall(ctx, { source: s, purpose: 'p', ok: i % 2, cost: 1, outTokens: 1 });
  assert.equal((await sweep(ctx)).filed, 1);
});
