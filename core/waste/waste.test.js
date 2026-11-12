// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { recordCall } from '../yield/index.js';
import { wasteRun, evaluateGauges, report } from './index.js';

const dirs = ['../yield/migrations/', './migrations/'].map(d => fileURLToPath(new URL(d, import.meta.url)));
const mk = (extra = {}) => ({ db: makeDb(dirs), now: () => Date.parse('2026-06-10T12:00:00Z'), config: { clean_runs_to_close: 2 }, ...extra });

test('evaluateGauges: backlog and stall breach at the limit; unread gauges and missing limits are ignored', () => {
  const f = evaluateGauges([{ name: 'q', kind: 'backlog', value: 500 }, { name: 't', kind: 'stall', value: 100, limit: 100 }, { name: 'ok', value: 1, limit: 5 }, { name: 'bad', value: null, limit: 1 }, { name: 'nolimit', value: 9 }], { q: 500 });
  assert.deepEqual(f.map(x => x.key), ['W-BACKLOG|q', 'W-STALL|t']);
});

test('a breaching gauge files one item, re-fire does not duplicate, clean runs close it, recurrence reopens', async () => {
  let depth = 900; const ctx = mk({ gauges: { jobs: { read: () => depth, limit: 500 } } });
  assert.equal((await wasteRun(ctx)).filed, 1);
  assert.equal((await wasteRun(ctx)).filed, 0);
  depth = 10;
  await wasteRun(ctx); const r = await wasteRun(ctx);
  assert.equal(r.closed, 1);
  assert.equal((await ctx.db.prepare("SELECT status FROM items WHERE id LIKE 'WST-%'").first()).status, 'done');
  depth = 900; await wasteRun(ctx);
  assert.equal((await ctx.db.prepare("SELECT status FROM items WHERE id LIKE 'WST-%'").first()).status, 'open');
});

test('a throwing gauge never files a finding; ledger rules still run in the same call', async () => {
  const ctx = mk({ gauges: { x: { read: () => { throw new Error('down'); }, limit: 1 } }, config: { rate_min_calls: 5, err_cost: 1e9 } });
  for (let i = 0; i < 10; i++) await recordCall(ctx, { source: 's', purpose: 'p', ok: i % 2, cost: 1, outTokens: 1 });
  const r = await wasteRun(ctx);
  assert.deepEqual([r.filed, r.gauge_findings, r.ledger_findings], [1, 0, 1]);
});

test('report ranks spenders and states the wasted share', async () => {
  const ctx = mk();
  for (let i = 0; i < 4; i++) await recordCall(ctx, { source: 'a', purpose: 'p', ok: i > 0, cost: 3, outTokens: 1 });
  await recordCall(ctx, { source: 'b', purpose: 'p', cost: 3, outTokens: 1 });
  const r = await report(ctx);
  assert.deepEqual([r.total_cost, r.top[0].source, r.top[0].wasted, r.top[0].share], [15, 'a', 3, 0.8]);
});
