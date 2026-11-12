// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createInfra, heartbeat, staleHeartbeats, capRows, secretsPresent, safeEqual } from './index.js';

const mig = fileURLToPath(new URL('./migrations/', import.meta.url));
const req = (p, o = {}) => new Request('http://h' + p, { method: o.method || 'GET', headers: { ...(o.auth ? { authorization: o.auth } : {}), ...(o.headers || {}) } });
const ok = async () => new Response('ok');
const mk = (extra = {}) => { const s = { t: 1e12 }; const db = makeDb([mig]); return { s, db, infra: createInfra({ db, now: () => s.t, env: { T: 's3cret' }, routes: [{ prefix: '/mcp', tokenEnv: 'T', handler: ok }, { prefix: '/open', methods: ['POST'], handler: ok }, { prefix: '/boom', handler: async () => { throw new Error('kaboom'); } }, { prefix: '/call', rate_limit: 2, handler: ok }], ...extra }) }; };

test('prefix match, bearer auth, closed when token unset, constant-time compare', async () => {
  const { infra } = mk();
  assert.equal((await infra.dispatch(req('/mcp'))).status, 401);
  assert.equal((await infra.dispatch(req('/mcp/x', { auth: 'Bearer s3cret' }))).status, 200);
  assert.equal(await infra.dispatch(req('/nothing')), null);
  const closed = createInfra({ routes: [{ prefix: '/mcp', tokenEnv: 'T', handler: ok }], env: {} });
  assert.equal((await closed.dispatch(req('/mcp', { auth: 'Bearer s3cret' }))).status, 503);
  assert.ok(safeEqual('a', 'a') && !safeEqual('a', 'ab'));
});

test('method filter, body cap, and handler errors without a stack', async () => {
  const { infra } = mk();
  const m = await infra.dispatch(req('/open')); assert.deepEqual([m.status, m.headers.get('allow')], [405, 'POST']);
  assert.equal((await infra.dispatch(req('/open', { method: 'POST', headers: { 'content-length': '9999999' } }))).status, 413);
  const b = await infra.dispatch(req('/boom')); assert.equal(b.status, 500); assert.ok(!(await b.text()).includes('    at '));
});

test('rate limit is per route and caller within a window, and resets in the next window', async () => {
  const { infra, s } = mk({ config: { rate_limit: 100, rate_window_ms: 1000 } });
  const st = []; for (let i = 0; i < 4; i++) st.push((await infra.dispatch(req('/call', { headers: { 'cf-connecting-ip': '1.1.1.1' } }))).status);
  assert.deepEqual(st, [200, 200, 429, 429]);
  assert.equal((await infra.dispatch(req('/call', { headers: { 'cf-connecting-ip': '2.2.2.2' } }))).status, 200);
  s.t += 1500; assert.equal((await infra.dispatch(req('/call', { headers: { 'cf-connecting-ip': '1.1.1.1' } }))).status, 200);
});

test('/health is live; /health/deep reports failing checks and silent heartbeats', async () => {
  const { infra, db, s } = mk({ checks: { db: async () => true, queue: async () => { throw new Error('x'); } } });
  assert.equal((await infra.dispatch(req('/health'))).status, 200);
  let d = await infra.dispatch(req('/health/deep')); assert.deepEqual([d.status, (await d.json()).checks], [503, { db: true, queue: false }]);
  const good = createInfra({ db, now: () => s.t, checks: { db: async () => true } });
  await heartbeat({ db, now: () => s.t }, 'cron', 10);
  assert.equal((await good.dispatch(req('/health/deep'))).status, 200);
  s.t += 21 * 60000;
  d = await good.dispatch(req('/health/deep')); assert.deepEqual([d.status, (await d.json()).stale_heartbeats], [503, [{ name: 'cron', silent_minutes: 21 }]]);
});

test('heartbeat keeps its period when later beats omit it; staleHeartbeats ignores jobs without a period', async () => {
  const { db, s } = mk(); const ctx = { db, now: () => s.t };
  await heartbeat(ctx, 'a', 5); await heartbeat(ctx, 'a'); await heartbeat(ctx, 'free');
  s.t += 11 * 60000;
  assert.deepEqual((await staleHeartbeats(ctx)).map(x => x.name), ['a']);
  assert.equal((await db.prepare("SELECT beats FROM infra_heartbeats WHERE name='a'").first()).beats, 2);
});

test('capRows bounds results; secretsPresent reports names, never values', () => {
  assert.deepEqual(capRows([1, 2, 3], 2), { rows: [1, 2], truncated: true, total: 3 });
  assert.deepEqual(secretsPresent({ A: 'x', B: '' }, ['A', 'B', 'C']), { A: true, B: false, C: false });
});
