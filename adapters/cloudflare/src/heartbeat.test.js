// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeartbeat, ensureArmed, TICK_EVERY_MS } from './heartbeat.js';

function world(tick) {
  const data = new Map(); let alarm = null;
  const storage = { async get(k) { return data.get(k); }, async put(k, v) { data.set(k, v); }, async getAlarm() { return alarm; }, async setAlarm(t) { alarm = t; } };
  const env = { TICK_MODE: 'alarm' };
  const obj = new (createHeartbeat(tick))({ storage }, env);
  env.HEARTBEAT = { idFromName: (n) => n, get: () => ({ fetch: () => obj.fetch() }) };
  return { obj, storage, env, alarmAt: () => alarm };
}

test('the alarm runs one tick of the org, records it and re-arms itself', async () => {
  let ticks = 0;
  const w = world(async () => { ticks += 1; });
  await w.obj.alarm(); await w.obj.alarm();
  assert.equal(ticks, 2);
  assert.ok((await w.storage.get('last_tick')).at);
  assert.ok(w.alarmAt() > Date.now() && w.alarmAt() <= Date.now() + TICK_EVERY_MS);
});

test('a failing tick is recorded and the heartbeat still re-arms', async () => {
  const w = world(async () => { throw new Error('db down'); });
  await w.obj.alarm();
  assert.match((await w.storage.get('last_error')).message, /db down/);
  assert.ok(w.alarmAt() > Date.now());
});

test('ensureArmed arms the alarm only in alarm mode, and never throws', async () => {
  const w = world(async () => {});
  assert.equal(await ensureArmed(w.env), true);
  assert.ok(w.alarmAt() > Date.now());
  assert.equal(await ensureArmed({ ...w.env, TICK_MODE: 'cron' }), false);
  assert.equal(await ensureArmed({ TICK_MODE: 'alarm' }), false);
  assert.equal(await ensureArmed({ TICK_MODE: 'alarm', HEARTBEAT: { idFromName() { throw new Error('x'); } } }), false);
});
