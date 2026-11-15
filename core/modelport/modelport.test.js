// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// US-SPEC-14 section 3: the Models port (alias to endpoint, completion with token counts, US-14-R10 deploy check) and the
// Role runtime port (one instance per role).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createModelPort, createRoleRuntime } from './index.js';

const MIG = fileURLToPath(new URL('./migrations/', import.meta.url));
const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);
const aliases = (reviewerFamily = 'family-b') => ({
  small: { endpoint: 'edge', model: 'm-small', family: 'family-a' },
  medium: { endpoint: 'edge', model: 'm-medium', family: 'family-a' },
  large: { endpoint: 'hosted', model: 'm-large', family: reviewerFamily, key_env: 'HOSTED_KEY' },
});
const endpoints = {
  edge: async ({ model, messages }) => ({ text: `${model}:${messages.at(-1).content}`, tokens_in: 7, tokens_out: 3 }),
  hosted: async ({ model }) => ({ text: `${model}:ok`, tokens_in: 11, tokens_out: 5 }),
};
const port = (over = {}) => createModelPort({ config: { aliases: aliases(), roles: { doer: 'medium', reviewer: 'large' } }, endpoints, env: { HOSTED_KEY: true }, ...over });

test('Models port: an alias resolves to an endpoint and returns a completion with token counts', async () => {
  const p = port();
  assert.deepEqual(p.resolve('small'), { ok: true, alias: 'small', endpoint: 'edge', model: 'm-small', family: 'family-a' });
  assert.deepEqual(await p.complete('small', { messages: [{ role: 'user', content: 'hi' }] }), { ok: true, text: 'm-small:hi', tokens_in: 7, tokens_out: 3, alias: 'small', model: 'm-small', family: 'family-a' });
  assert.equal(p.resolve('huge').ok, false);
});

test('Models port: an endpoint that returns no token counts, or throws, is an error and never a made-up completion', async () => {
  const p = port({ endpoints: { edge: async () => ({ text: 'x' }), hosted: async () => { throw new Error('503 from upstream'); } } });
  assert.match((await p.complete('small', { messages: [] })).error, /token counts/);
  const r = await p.complete('large', { messages: [] });
  assert.equal(r.ok, false); assert.match(r.error, /503 from upstream/); assert.equal(r.family, 'family-b');
});

test('US-14-R04: the port sees only whether a key is present; a missing key makes the alias unusable', async () => {
  const p = port({ env: { HOSTED_KEY: false } });
  assert.match(p.resolve('large').error, /HOSTED_KEY is not present/);
  assert.equal((await p.complete('large', { messages: [] })).ok, false);
  const leaky = port({ env: { HOSTED_KEY: 'a-secret-value' } });
  assert.equal(leaky.resolve('large').ok, false, 'a value in place of the presence flag is not accepted');
});

test('US-14-R10: the deploy check fails when reviewer and doer resolve to one family while two are available', () => {
  assert.deepEqual(port().deployCheck().errors, []);
  assert.deepEqual(port().deployCheck().families, ['family-a', 'family-b']);
  const same = port({ config: { aliases: aliases(), roles: { doer: 'medium', reviewer: 'small' } } }).deployCheck();
  assert.equal(same.ok, false); assert.match(same.errors[0], /both resolve to family family-a while 2 families are available/);
});

test('US-14-R10: with one family available the check passes with a warning; a second family whose key is absent does not count', () => {
  const one = port({ config: { aliases: aliases('family-a'), roles: { doer: 'medium', reviewer: 'large' } } }).deployCheck();
  assert.equal(one.ok, true); assert.match(one.warnings[0], /only one model family/);
  const noKey = port({ config: { aliases: aliases(), roles: { doer: 'medium', reviewer: 'small' } }, env: {} }).deployCheck();
  assert.ok(!noKey.errors.some(e => /both resolve/.test(e))); assert.ok(noKey.errors.some(e => /HOSTED_KEY/.test(e)));
  const bad = port({ config: { aliases: aliases(), roles: { doer: 'medium', reviewer: 'xl' } } }).deployCheck();
  assert.ok(bad.errors.some(e => /role reviewer names alias xl/.test(e)));
});

const mk = (handlers, cfg = {}) => {
  const db = makeDb([MIG]); const t = { v: T0 };
  db.raw.exec(`INSERT INTO roles (id, role, tick_every, model) VALUES ('pm-1','product-manager',1,'medium'),('staff-1','staff',1,'small'),('staff-2','staff',1,'custom-model-name');
    INSERT INTO items (id,title,owner_role,done_check,status) VALUES ('A','Write the page','staff','x','claimed'),('B','b','staff','x','claimed'),('C','c','product-manager','x','claimed');`);
  return { db, t, rt: createRoleRuntime({ db, models: port(), handlers, now: () => t.v, config: cfg }) };
};

test('Role runtime: one instance per role row, and a run records the model, family and tokens it used', async () => {
  const { db, rt } = mk({ default: async ({ role, item, complete }) => { const r = await complete({ messages: [{ role: 'user', content: item.title }] }); return { ok: r.ok, detail: `${role.id} said ${r.text}` }; } });
  assert.deepEqual((await rt.instances()).map(i => i.role_id), ['pm-1', 'staff-1', 'staff-2']);
  const r = await rt.runRole('staff-1', { item: { id: 'A', title: 'Write the page' } });
  assert.deepEqual(r, { ok: true, detail: 'staff-1 said m-small:Write the page', alias: 'small', tokens_in: 7, tokens_out: 3, model: 'm-small', family: 'family-a' });
  const row = db.raw.prepare(`SELECT * FROM modelport_runs`).get();
  assert.equal(row.role_id, 'staff-1'); assert.equal(row.item_id, 'A'); assert.equal(row.tokens_in, 7); assert.equal(row.status, 'done'); assert.equal(row.at, '2026-11-15 12:00:00');
  assert.equal((await rt.runRole('staff-2', { item: { id: 'B', title: 'b' } })).alias, 'small', 'a role whose model is not an alias uses the default alias');
  assert.equal((await rt.runRole('nobody')).ok, false);
  const inst = (await rt.instances()).find(i => i.role_id === 'staff-1');
  assert.equal(inst.runs, 1); assert.equal(inst.lease_until, null);
});

test('Role runtime: an instance runs one piece of work at a time; a second runtime is refused until the lease ends', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const { db, t, rt } = mk({ default: async () => { await gate; return { ok: true, detail: 'finished' }; } });
  const other = createRoleRuntime({ db, models: port(), handlers: { default: async () => ({ ok: true, detail: 'other' }) }, now: () => t.v, config: { holder: 'runtime-2' } });
  const first = rt.runRole('staff-1');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(await rt.runRole('staff-1'), { ok: false, busy: true, error: 'this role instance is already running' });
  assert.equal((await other.runRole('staff-1')).busy, true);
  assert.equal((await other.runRole('staff-2')).ok, true, 'another role is not blocked');
  release(); assert.equal((await first).ok, true);
  assert.equal((await other.runRole('staff-1')).ok, true);
  // a runtime that died mid-run: its lease expires and the instance can run again
  await rt.instances();
  db.raw.exec(`UPDATE modelport_instances SET holder='dead', lease_until='2026-11-15 12:10:00' WHERE role_id='pm-1'`);
  assert.equal((await rt.runRole('pm-1')).busy, true);
  t.v += 11 * 60e3;
  assert.equal((await rt.runRole('pm-1')).ok, true);
});

test('Role runtime: queued dispatches are worked by their role instance and end done or failed; a throwing handler is a failed run', async () => {
  const { db, rt } = mk({ staff: async ({ item }) => { if (item.id === 'B') throw new Error('tool crashed'); return { ok: true, detail: `did ${item.id}` }; }, 'product-manager': async () => ({ ok: true, detail: 'planned' }) });
  db.raw.exec(`INSERT INTO dispatches (tick_id, role_id, item_id, model) VALUES (1,'staff-1','A','small'),(1,'staff-1','B','small'),(1,'pm-1','C','medium')`);
  assert.deepEqual(await rt.runDispatches(), { done: 2, failed: 1, busy: 0 });
  assert.deepEqual(db.raw.prepare(`SELECT item_id, status FROM dispatches ORDER BY id`).all().map(r => `${r.item_id}:${r.status}`), ['A:done', 'B:failed', 'C:done']);
  assert.match(db.raw.prepare(`SELECT detail FROM modelport_runs WHERE item_id='B'`).get().detail, /tool crashed/);
  assert.deepEqual(await rt.runDispatches(), { done: 0, failed: 0, busy: 0 });
  const none = createRoleRuntime({ db, models: port(), handlers: {} });
  assert.match((await none.runRole('staff-1')).error, /no handler for role staff/);
});
