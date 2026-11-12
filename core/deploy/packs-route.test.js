// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Class D packs act only through core/deploy: the route is chosen by the guard from the pack class, never by a flag in the request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { KERNEL_DIR } from '../kernel/testkit.js';
import { createPacks, loadManifest, MIGRATIONS_DIR } from '../packs/index.js';
import { createDeploy } from './index.js';
import { createPacksRoute } from './packs-route.js';

const DEPLOY_MIG = fileURLToPath(new URL('./migrations/', import.meta.url));
const EXAMPLE_DIR = fileURLToPath(new URL('../packs/example/', import.meta.url));
const T0 = Date.parse('2026-11-11T10:00:00Z');
const one = (db, sql, ...a) => db.raw.prepare(sql).get(...a);
const rows = (db, sql, ...a) => db.raw.prepare(sql).all(...a).map(r => ({ ...r }));

function setup({ healthy = true, withRoute = true, rung = 'delegated', allow = null } = {}) {
  const db = makeDb([KERNEL_DIR, MIGRATIONS_DIR, DEPLOY_MIG]);
  const clock = { t: T0 };
  const web = { healthy };
  const deployer = { live: 'v1', calls: [],
    async liveVersion() { return this.live; },
    async publish(unit, a) { this.calls.push(`publish ${a.version}`); this.live = a.version; return { version: a.version }; },
    async rollback(unit, to) { this.calls.push(`rollback ${to}`); this.live = to; } };
  const fetch = async () => new Response(web.healthy ? '{"ok":true}' : 'down', { status: web.healthy ? 200 : 500 });
  const deploy = createDeploy({ db, deployer, fetch, now: () => clock.t, sleep: async ms => { clock.t += ms; }, config: { windowMs: 4000, intervalMs: 2000 },
    probes: { web: [{ kind: 'http', url: 'https://svc.example/health', contains: ['"ok":true'] }] } });
  const channel = { sent: [], send: async m => { channel.sent.push(m); return { id: 'chan' }; } };
  const route = createPacksRoute({ deploys: { cf: deploy },
    plan: req => ({ provider: 'cf', unit: req.recipient, artifact: { version: JSON.parse(req.content).version, body: 'code' }, expectedVersion: 'v1' }), allow });
  const packs = createPacks({ db, now: () => clock.t, config: {}, channels: { fake: channel }, ...(withRoute ? { deployRoute: route } : {}) });
  if (rung) db.raw.prepare(`INSERT INTO trust_ledger (surface, action_class, rung, reliability, outcomes) VALUES ('pack:dpack','deploy',?,1,50)`).run(rung);
  return { db, packs, deployer, web, channel, guard: packs.guard, clock };
}
async function enableD(packs, cls = 'D') {
  const m = loadManifest(EXAMPLE_DIR);
  Object.assign(m, { id: 'dpack', class: cls });
  m.charter.primary_metric.id = 'dpack_a'; m.charter.guard_metrics[0].id = 'dpack_b';
  m.loops = [{ id: 'noop', every_ticks: 1, entry: './noop.js#run', outbound: true }];
  m.outbound = { channels: ['fake'], caps: { fake: { per_day: 5, per_week: 10 } }, consent: 'none', suppression: true, approval: 'by_rung' };
  delete m.defaults;
  assert.equal((await packs.register(m, { dir: EXAMPLE_DIR })).ok, true);
  assert.equal((await packs.enablePack('dpack', { by: 'owner', cardText: m.enable_gate })).ok, true);
}
const dep = (version, o = {}) => ({ pack: 'dpack', channel: 'fake', kind: 'deploy', recipient: 'web', content: JSON.stringify({ version }), idempotencyKey: `d-${version}`, ...o });

test('a class D pack with no deploy route cannot act, and a viaDeploy flag in the request changes nothing', async () => {
  const { packs, guard, deployer, channel } = setup({ withRoute: false });
  await enableD(packs);
  assert.equal((await guard.send(dep('v2'))).reason, 'class_d_requires_deploy');
  assert.equal((await guard.send(dep('v3', { viaDeploy: true }))).reason, 'class_d_requires_deploy');
  assert.equal((await packs.boundGuard('dpack').send(dep('v4', { viaDeploy: true }))).reason, 'class_d_requires_deploy');
  assert.deepEqual(deployer.calls, []); assert.deepEqual(channel.sent, []);
});

test('with the route, a class D send is a core/deploy run: ledger row kept, channel port never called', async () => {
  const { db, packs, guard, deployer, channel } = setup();
  await enableD(packs);
  const r = await guard.send(dep('v2'));
  assert.equal(r.decision, 'sent');
  assert.deepEqual(deployer.calls, ['publish v2']); assert.deepEqual(channel.sent, []);
  const led = rows(db, `SELECT id, unit, actor, status, from_version, to_version FROM deploy_ledger`);
  assert.deepEqual(led, [{ id: led[0].id, unit: 'web', actor: 'pack:dpack', status: 'kept', from_version: 'v1', to_version: 'v2' }]);
  assert.equal(one(db, `SELECT provider_id FROM guard_ledger WHERE decision = 'sent'`).provider_id, String(led[0].id));
});

test('a failed probe reverts the deploy and the guard records a refusal, not a send', async () => {
  const { db, packs, guard, deployer } = setup({ healthy: false });
  await enableD(packs);
  const r = await guard.send(dep('v2'));
  assert.equal(r.decision, 'refused'); assert.match(r.reason, /^delivery_failed: deploy_reverted/);
  assert.deepEqual(deployer.calls, ['publish v2', 'rollback v1']);
  assert.equal(one(db, `SELECT status FROM deploy_ledger`).status, 'reverted');
  assert.equal(one(db, `SELECT COUNT(*) n FROM guard_ledger WHERE decision = 'sent'`).n, 0);
});

test('the deploy kill switch and the stale-version check still bind a class D pack', async () => {
  const { db, packs, guard, deployer } = setup();
  await enableD(packs);
  db.raw.prepare(`INSERT INTO deploy_config (key, value) VALUES ('kill_switch', 'on')`).run();
  const k = await guard.send(dep('v2'));
  assert.match(k.reason, /delivery_failed: deploy_refused: kill_switch/);
  db.raw.prepare(`UPDATE deploy_config SET value = 'off' WHERE key = 'kill_switch'`).run();
  deployer.live = 'v9';
  assert.match((await guard.send(dep('v3'))).reason, /deploy_refused: stale_version/);
  assert.deepEqual(deployer.calls, []);
});

test('the route can restrict which units a pack may deploy', async () => {
  const { packs, guard, deployer } = setup({ allow: (pack, unit) => pack === 'dpack' && unit === 'web' });
  await enableD(packs);
  assert.match((await guard.send(dep('v2', { recipient: 'other-unit' }))).reason, /unit_not_allowed: other-unit/);
  assert.deepEqual(deployer.calls, []);
  assert.equal((await guard.send(dep('v2'))).decision, 'sent');
});

test('below the act rung the deploy waits as a card; approval runs it through core/deploy, not a channel', async () => {
  const { db, packs, guard, deployer, channel } = setup({ rung: 'assisted' });
  await enableD(packs);
  const q = await guard.send(dep('v2'));
  assert.equal(q.decision, 'queued_for_approval');
  assert.deepEqual(deployer.calls, []);
  const a = await guard.approve(q.queueId, { by: 'owner' });
  assert.equal(a.decision, 'sent');
  assert.deepEqual(deployer.calls, ['publish v2']); assert.deepEqual(channel.sent, []);
  assert.equal(one(db, `SELECT COUNT(*) n FROM deploy_ledger WHERE status = 'kept'`).n, 1);
});

test('a class B pack ignores the route and still sends through its channel port', async () => {
  const { packs, guard, deployer, channel } = setup();
  await enableD(packs, 'B');
  assert.equal((await guard.send(dep('v2'))).decision, 'sent');
  assert.equal(channel.sent.length, 1); assert.deepEqual(deployer.calls, []);
});

test('createPacksRoute needs deploys and a plan', () => {
  assert.throws(() => createPacksRoute({}), /needs deploys and plan/);
});
