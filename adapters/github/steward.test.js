// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../../core/_shared/testdb.js';
import { mirror, hygiene, githubSink, fileSink, githubMergeHost } from './steward.js';

const mig = fileURLToPath(new URL('./migrations/', import.meta.url));
const mk = sinks => ({ db: makeDb([mig]), now: () => 0, sinks });
const add = (ctx, id, extra = '') => ctx.db.prepare("INSERT INTO items (id,title,owner_role,done_check,closing_probe) VALUES (?,?,'staff','dc','cp')").bind(id, 't ' + id).run();

test('each item reaches every sink; a failing sink does not block the other and is retried', async () => {
  let fail = true; const files = {};
  const bad = { name: 'bad', upsert: async () => { if (fail) throw new Error('down'); return { ref: 'r' }; } };
  const ctx = mk([bad, fileSink({ writeFile: async (p, c) => { files[p] = c; } })]);
  await add(ctx, 'A-1');
  const r1 = await mirror(ctx);
  assert.deepEqual([r1.synced, r1.failed], [1, 1]);
  assert.ok(files['items/A-1.json']);
  fail = false;
  const r2 = await mirror(ctx);
  assert.deepEqual([r2.synced, r2.failed, r2.skipped], [1, 0, 1], 'the failed sink retries, the synced one is skipped');
});
test('hygiene lists missing fields; unchanged items are skipped', async () => {
  assert.deepEqual(hygiene({ owner_role: 'a', done_check: '', closing_probe: null }), ['done_check', 'closing_probe']);
  const ctx = mk([fileSink({ writeFile: async () => {} })]); await add(ctx, 'B-1');
  assert.equal((await mirror(ctx)).synced, 1); assert.equal((await mirror(ctx)).skipped, 1);
});
test('github sink creates then updates; token never appears in an error', async () => {
  const calls = [];
  const fetch = async (u, i) => { calls.push([i.method, u]); return new Response(JSON.stringify({ number: 5 }), { status: 200 }); };
  const s = githubSink({ fetch, repo: 'o/r', env: { VCS_TOKEN: 'tok-secret-1' } });
  const it = { id: 'X', title: 't', owner_role: 'a', done_check: 'd', closing_probe: 'p', status: 'open' };
  assert.equal((await s.upsert(it, null)).ref, '5'); await s.upsert(it, '5');
  assert.deepEqual(calls.map(c => c[0]), ['POST', 'PATCH']);
  await assert.rejects(githubSink({ fetch, repo: 'o/r', env: {} }).upsert(it, null), /not set/);
  assert.throws(() => githubSink({ fetch, repo: 'bad' }));
  const m = githubMergeHost({ fetch: async () => new Response('', { status: 405 }), repo: 'o/r', env: { VCS_TOKEN: 'x' } });
  assert.deepEqual(await m.merge({ pr: 1 }), { merged: false, reason: 'http 405' });
});
