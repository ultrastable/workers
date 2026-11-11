// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { ingest, evaluate, p95 } from './index.js';
const mk = (config = {}) => ({ db: makeDb([fileURLToPath(new URL('./migrations/', import.meta.url))]), now: () => Date.parse('2026-06-10T12:00:00Z'), config });

test('p95 of a known list', () => { assert.equal(p95([1, 2, 3, 4, 100]), 100); assert.equal(p95([]), null); });
test('a source with a high error ratio files one fix item, once', async () => {
  const ctx = mk({ min_events: 10 });
  for (let i = 0; i < 20; i++) await ingest(ctx, { source: 'svc-a', status: i % 2 ? 500 : 200, durationMs: 50 });
  for (let i = 0; i < 20; i++) await ingest(ctx, { source: 'svc-b', status: 200, durationMs: 50 });
  const r = await evaluate(ctx); await evaluate(ctx);
  assert.deepEqual(r.filter(x => x.degraded).map(x => x.source), ['svc-a']);
  assert.equal((await ctx.db.prepare("SELECT COUNT(*) n FROM items WHERE id LIKE 'OBS-%'").first()).n, 1);
});
test('slow p95 degrades a source with no errors', async () => {
  const ctx = mk({ min_events: 5 });
  for (let i = 0; i < 10; i++) await ingest(ctx, { source: 'slow', status: 200, durationMs: 9000 });
  assert.equal((await evaluate(ctx))[0].degraded, true);
});
test('token-like strings are scrubbed from stored detail', async () => {
  const ctx = mk();
  await ingest(ctx, { source: 's', status: 500, detail: 'auth failed for ' + 'a'.repeat(40) });
  assert.match((await ctx.db.prepare('SELECT detail FROM observe_events').first()).detail, /\[redacted\]/);
});
