// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Heartbeat, TICK_EVERY_MS } from '../preview/entry.js';
import { makeDb } from '../../../core/_shared/testdb.js';

/** A Durable Object world in memory: storage with one alarm, and a namespace that hands out one instance. */
function fakeDo(env) {
  const data = new Map(); let alarm = null;
  const storage = { async get(k) { return data.get(k); }, async put(k, v) { data.set(k, v); }, async getAlarm() { return alarm; }, async setAlarm(t) { alarm = t; } };
  const obj = new Heartbeat({ storage }, env);
  env.HEARTBEAT = { idFromName: (n) => n, get: () => ({ fetch: (u, i) => obj.fetch(new Request(u, i)) }) };
  return { obj, storage, alarmAt: () => alarm };
}
const health = async (env) => (await worker.fetch(new Request('https://x.test/health'), env)).json();

test('/health reports last_tick null before the first alarm and arms the alarm', async () => {
  const env = { DB: makeDb(), ORG_SLUG: 'x' };
  const w = fakeDo(env);
  const h = await health(env);
  assert.equal(h.last_tick, null);
  assert.ok(w.alarmAt() > Date.now(), 'alarm armed in the future');
});

test('the alarm runs the real tick, records last_tick, and re-arms itself', async () => {
  const env = { DB: makeDb(), ORG_SLUG: 'x' };
  const w = fakeDo(env);
  await health(env);
  await w.obj.alarm();
  const h = await health(env);
  assert.ok(h.last_tick && h.last_tick.at, 'last_tick is non-null');
  assert.equal(h.last_tick.errors, 0);
  assert.match(h.last_tick.steps, /^8\/8$/);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM tick_runs').get().n, 1);
  assert.ok(w.alarmAt() > Date.now() && w.alarmAt() <= Date.now() + TICK_EVERY_MS, 're-armed');
  await w.obj.alarm();
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM tick_runs').get().n, 2, 'tick_runs advances');
});

test('a failing database never stops the heartbeat: the error is recorded and the alarm is re-armed', async () => {
  const env = { DB: { prepare() { throw new Error('db down'); } }, ORG_SLUG: 'x' };
  const w = fakeDo(env);
  await w.obj.alarm();
  assert.ok(w.alarmAt() > Date.now());
  assert.match((await w.storage.get('last_error')).message, /db down/);
  assert.equal((await health(env)).last_tick, null);
});

test('without the binding (not yet deployed with it) /health still answers', async () => {
  assert.equal((await health({ ORG_SLUG: 'x' })).last_tick, null);
});
