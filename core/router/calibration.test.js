// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createRouter } from './router.js';
import { calibrate, probes } from './calibration.js';

const MIG = fileURLToPath(new URL('./migrations/', import.meta.url));
const EX = JSON.parse(readFileSync(new URL('./example-config.json', import.meta.url), 'utf8'));
const ENV = { PROVIDER_A_API_KEY: 'sk-aaaa-secret', PROVIDER_B_API_KEY: 'sk-bbbb-secret' };
function mk(h) {
  const db = makeDb([MIG]); let t = 0;
  const fetch = async (url, init) => {
    const a = url.includes('provider-a'), mode = a ? h.a : h.b;
    if (mode.fail) return new Response('x', { status: 500 });
    const text = mode.bad ? 'garbage' : (JSON.parse(init.body).messages?.[0]?.content?.includes('JSON') ? '{"ok":true}' : 'OK');
    return new Response(JSON.stringify(a ? { choices: [{ message: { content: text } }], usage: {} } : { content: [{ type: 'text', text }], usage: {} }), { status: 200 });
  };
  const now = () => (t += 5);
  const router = createRouter({ db, fetch, now, config: EX, env: ENV });
  return { ctx: { db, now, config: {}, router }, router };
}
const args = { providers: EX.providers, rungs: ['small'] };

test('a failing provider is steered away after a streak, the other route stays', async () => {
  const { ctx, router } = mk({ a: { fail: true }, b: {} });
  let r; for (let i = 0; i < 2; i++) r = await calibrate(ctx, args);
  assert.deepEqual(r.switched_off, ['provider-a']);
  const plan = await router.route({ rung: 'small' });
  assert.ok(plan.ok && plan.candidates.every(c => c.provider === 'provider-b'));
  assert.equal((await ctx.db.prepare("SELECT status FROM items WHERE id='CAL-provider-a'").first()).status, 'open');
});

test('the last healthy route is never switched off', async () => {
  const { ctx } = mk({ a: { fail: true }, b: { fail: true } });
  for (let i = 0; i < 3; i++) await calibrate(ctx, args);
  const sw = (await ctx.db.prepare("SELECT COUNT(*) n FROM router_switches WHERE is_on=1").first()).n;
  assert.equal(sw, 0);
});

test('recovery switches the provider back on and closes the item', async () => {
  const h = { a: { fail: true }, b: {} };
  const { ctx, router } = mk(h);
  for (let i = 0; i < 2; i++) await calibrate(ctx, args);
  assert.equal((await router.route({ rung: 'small' })).candidates.some(c => c.provider === 'provider-a'), false);
  h.a.fail = false;
  let r; for (let i = 0; i < 2; i++) r = await calibrate(ctx, args);
  assert.ok(r.switched_on.includes('provider-a'));
  assert.equal((await ctx.db.prepare("SELECT status FROM items WHERE id='CAL-provider-a'").first()).status, 'done');
  assert.ok(probes.length >= 2);
});
