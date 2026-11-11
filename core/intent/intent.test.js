// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { submit } from './index.js';
const mk = () => ({ db: makeDb([fileURLToPath(new URL('./migrations/', import.meta.url))]), now: () => Date.now(), config: {} });

test('a request files one item; the same request again is a duplicate', async () => {
  const ctx = mk();
  const a = await submit(ctx, { client: 'chat', text: 'Add a /health route' });
  const b = await submit(ctx, { client: 'cli', text: '  add a /HEALTH   route ' });
  assert.equal(a.verdict, 'filed'); assert.equal(b.verdict, 'duplicate'); assert.equal(b.item_id, a.item_id);
  assert.equal((await ctx.db.prepare("SELECT COUNT(*) n FROM items WHERE id LIKE 'INT-%'").first()).n, 1);
});
test('empty and oversized requests are rejected and recorded', async () => {
  const ctx = mk();
  assert.equal((await submit(ctx, { client: 'c', text: '  ' })).verdict, 'rejected');
  assert.equal((await submit(ctx, { client: 'c', text: 'x'.repeat(5000) })).verdict, 'rejected');
  assert.equal((await ctx.db.prepare('SELECT COUNT(*) n FROM intent_requests').first()).n, 2);
});
test('an identity-bound request is filed blocked, not open', async () => {
  const ctx = mk();
  const r = await submit(ctx, { client: 'c', text: 'Please wire money to the vendor' });
  assert.equal(r.verdict, 'gated');
  assert.equal((await ctx.db.prepare('SELECT status FROM items WHERE id=?').bind(r.item_id).first()).status, 'blocked');
});
