// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { run, compose, tune, recordReferrals, snapshot, evaluate, ideaToItem, indexnowKey, halted } from './index.js';

const dirs = [fileURLToPath(new URL('./migrations/', import.meta.url))];
const calls = [];
const mk = (over = {}) => ({ db: makeDb(dirs), now: () => Date.parse('2026-06-10T12:00:00Z'), env: { MASTODON_TOKEN: 'x' }, fetch: async (u, o) => { calls.push({ u, o }); return { ok: true, status: 200, json: async () => ({}) }; },
  config: { promote: { tenant: 't1', origin: 'https://example.org', channels: { indexnow: {}, mastodon: { base: 'https://m.example', perDay: 1 }, bluesky: {} }, ...over } } });
const e = (id, url = 'https://example.org/s/' + id) => ({ id, title: 'Title ' + id, url, summary: 'Sum', label: 'strong evidence', tags: ['health', 'x y'] });

test('posts are labelled, linked to own origin, idempotent, capped; missing credentials are skipped not faked', async () => {
  const ctx = mk(); calls.length = 0;
  const r = await run(ctx, [e('a'), e('b'), e('f', 'https://evil.test/x')]);
  assert.equal(r.sent.filter(s => s.ch === 'mastodon').length, 1);
  assert.ok(r.skipped.some(s => s.why === 'daily cap') && r.skipped.some(s => s.why === 'foreign link'));
  assert.ok(r.skipped.some(s => s.ch === 'bluesky' && s.why === 'credentials missing'));
  const m = calls.find(c => c.u.endsWith('/api/v1/statuses')); assert.match(JSON.parse(m.o.body).status, /Automated post/);
  const ix = JSON.parse(calls.find(c => c.u.includes('indexnow')).o.body); assert.deepEqual(ix.urlList.sort(), ['https://example.org/s/a', 'https://example.org/s/b']);
  const again = await run(ctx, [e('a'), e('b')]); assert.equal(again.sent.length, 0);
});

test('kill switch stops everything', async () => {
  const ctx = mk({ halt: true }); calls.length = 0;
  assert.equal(halted(ctx), true); assert.equal((await run(ctx, [e('a')])).halted, true); assert.equal(calls.length, 0);
});

test('compose respects channel length; tune favours channels with referrals; targets alert', async () => {
  assert.ok(compose('bluesky', { ...e('a'), summary: 'x'.repeat(900) }, {}, { promote: {} }).length <= 300);
  const ctx = mk(); await run(ctx, [e('a')]);
  const p = (await ctx.db.prepare("SELECT idem FROM promote_posts WHERE channel='mastodon'").first()).idem;
  await recordReferrals(ctx, p, 9); assert.ok((await tune(ctx)).mastodon > 1);
  await snapshot(ctx, { referrals: 3 });
  assert.equal((await evaluate(ctx, { referrals: { min: 20, windowDays: 7 } }))[0].value, 3);
  assert.equal((await evaluate(ctx, { referrals: { min: 2, windowDays: 7 } })).length, 0);
  assert.equal((await indexnowKey('t1')).length, 32);
});

test('idea becomes a complete work item', () => {
  const i = ideaToItem({ number: 7, title: 'Add a thing', body: 'because' });
  assert.ok(i.labels.includes('agent-ready')); assert.match(i.body, /Closing probe/);
});
