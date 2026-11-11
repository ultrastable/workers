// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createDeploy } from './index.js';
import { step, parseRequest } from './agent.js';

const MIG = fileURLToPath(new URL('./migrations/', import.meta.url));
function setup({ healthy = true } = {}) {
  const db = makeDb([MIG]); let t = Date.parse('2026-11-11T00:00:00Z'), live = 'v1';
  const deployer = { liveVersion: async () => live, publish: async (u, a) => { live = a.version; return { version: a.version }; }, rollback: async (u, to) => { live = to; } };
  const fetch = async () => new Response(healthy ? '{"ok":true,"version":"v2"}' : 'down', { status: healthy ? 200 : 500 });
  const deploy = createDeploy({ db, deployer, fetch, now: () => t, sleep: async ms => { t += ms; }, probes: { web: [{ kind: 'http', url: 'https://h.example/health', contains: ['"ok":true'], version: true }] }, config: {} });
  return { db, deploy, liveVersion: deployer.liveVersion };
}
const item = (db, id, dc) => db.prepare("INSERT INTO items (id,title,owner_role,done_check,status) VALUES (?,?,'operations',?,'open')").bind(id, 't', dc).run();

test('parseRequest reads unit and optional version', () => {
  assert.deepEqual(parseRequest('x deploy-unit: web; version: v2'), { unit: 'web', version: 'v2' });
  assert.equal(parseRequest('nothing'), null);
});
test('no single route: first source throws, second supplies; a kept deploy closes the item with the ledger id', async () => {
  const { db, deploy, liveVersion } = setup(); await item(db, 'D-1', 'deploy-unit: web; version: v2');
  const sources = [{ name: 'a', fetch: async () => { throw new Error('down'); } }, { name: 'b', fetch: async (u, v) => ({ version: v, body: 'code' }) }];
  const r = await step({ db, deploy, liveVersion, sources });
  assert.equal(r[0].status, 'kept');
  const it = await db.prepare("SELECT status, disposition FROM items WHERE id='D-1'").first();
  assert.equal(it.status, 'done'); assert.match(it.disposition, /ledger/);
});
test('a failing probe reverts: the item stays open with the reason as blocker', async () => {
  const { db, deploy, liveVersion } = setup({ healthy: false }); await item(db, 'D-2', 'deploy-unit: web; version: v2');
  const r = await step({ db, deploy, liveVersion, sources: [{ name: 'a', fetch: async (u, v) => ({ version: v, body: 'x' }) }] });
  assert.equal(r[0].status, 'reverted');
  const it = await db.prepare("SELECT status, blocker FROM items WHERE id='D-2'").first();
  assert.equal(it.status, 'open'); assert.match(it.blocker, /reverted/);
});
test('no artifact from any source is recorded as a blocker, not dropped', async () => {
  const { db, deploy, liveVersion } = setup(); await item(db, 'D-3', 'deploy-unit: web');
  const r = await step({ db, deploy, liveVersion, sources: [{ name: 'a', fetch: async () => null }] });
  assert.equal(r[0].status, 'no_artifact');
  assert.match((await db.prepare("SELECT blocker FROM items WHERE id='D-3'").first()).blocker, /no artifact/);
});
