// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createDeploy, dbLock } from './index.js';

const MIG = fileURLToPath(new URL('./migrations/', import.meta.url));
const SECRET = 'tok-very-secret-value';

function fakeDeployer(live = 'v1', opts = {}) {
  const s = { live, calls: [] };
  return Object.assign(s, {
    async liveVersion() { return s.live; },
    async publish(unit, artifact) { s.calls.push('publish'); s.live = artifact.version; return { version: artifact.version }; },
    async rollback(unit, to) { s.calls.push('rollback'); if (!opts.brokenRollback) s.live = to; },
  });
}
// healthy flag drives the health endpoint; body reports the version.
function fakeFetch(state) {
  return async (url) => new Response(state.healthy ? `{"ok":true,"version":"${state.version}"}` : 'down', { status: state.healthy ? 200 : 500 });
}
function setup(over = {}) {
  const db = makeDb([MIG]);
  const deployer = over.deployer || fakeDeployer();
  const web = { healthy: true, version: 'v2' };
  let t = Date.parse('2026-11-11T00:00:00Z');
  const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
  const d = createDeploy({ db, deployer, fetch: fakeFetch(web), now: clock.now, sleep: clock.sleep, env: { DEPLOY_TOKEN: SECRET },
    config: { windowMs: 6000, intervalMs: 2000, ...(over.config || {}) },
    probes: { api: [{ kind: 'http', url: 'https://svc.example/health', contains: ['"ok":true'], version: true }] }, ...(over.extra || {}) });
  return { db, deployer, web, d, clock };
}
const art = (v, body = 'code-' + v) => ({ version: v, body });
const rows = async (db, sql) => (await db.prepare(sql).all()).results;

test('migration is idempotent and tables are deploy_ prefixed', async () => {
  const sql = readFileSync(MIG + '0001_deploy.sql', 'utf8');
  const { db } = setup();
  db.raw.exec(sql);
  const names = (await rows(db, `SELECT name FROM sqlite_master WHERE name LIKE 'deploy\\_%' ESCAPE '\\' AND type='table'`)).map(r => r.name);
  assert.ok(names.includes('deploy_ledger') && names.includes('deploy_lock'));
});

test('US-07-T05 / R12: passing probes keep the deploy', async () => {
  const { d, deployer, db } = setup();
  const r = await d.deploy({ unit: 'api', artifact: art('v2'), expectedVersion: 'v1', actor: 'agent-a' });
  assert.equal(r.status, 'kept');
  assert.equal(deployer.live, 'v2');
  const [row] = await d.ledger('api');
  assert.equal(row.from_version, 'v1'); assert.equal(row.to_version, 'v2'); assert.equal(row.actor, 'agent-a');
  assert.match(row.artifact_sha256, /^[0-9a-f]{64}$/);
  assert.ok(row.finished_at);
  assert.equal((await rows(db, `SELECT * FROM deploy_lock`)).length, 0); // lock released
});

test('US-07-R12 / US-14-R08: failing probe rolls back automatically and records why', async () => {
  const { d, deployer, web } = setup();
  web.healthy = false;
  const r = await d.deploy({ unit: 'api', artifact: art('v2'), expectedVersion: 'v1', actor: 'a' });
  assert.equal(r.status, 'reverted');
  assert.match(r.reason, /probe_failed/);
  assert.equal(deployer.live, 'v1');
  assert.deepEqual(deployer.calls, ['publish', 'rollback']);
});

test('a probe that passes only after a delay inside the window is kept', async () => {
  const { d, web, clock } = setup();
  web.healthy = false;
  const base = clock.sleep;
  let n = 0;
  const d2 = createDeploy({ db: setup().db, deployer: fakeDeployer(), fetch: async () => (++n >= 3 ? new Response('{"ok":true,"version":"v2"}') : new Response('x', { status: 500 })),
    now: clock.now, sleep: base, config: { windowMs: 10000, intervalMs: 1000 }, probes: { api: [{ kind: 'http', url: 'https://svc.example/h', contains: ['ok'] }] } });
  assert.equal((await d2.deploy({ unit: 'api', artifact: art('v2'), expectedVersion: 'v1' })).status, 'kept');
});

test('stale expectedVersion is refused and nothing is published', async () => {
  const { d, deployer } = setup();
  const r = await d.deploy({ unit: 'api', artifact: art('v2'), expectedVersion: 'v0', actor: 'a' });
  assert.equal(r.status, 'refused');
  assert.match(r.reason, /stale_version/);
  assert.deepEqual(deployer.calls, []);
  assert.equal((await d.ledger('api'))[0].status, 'refused'); // refusals are ledgered
});

test('US-07-R12: deploys of one unit are serialized by the lock; other units are not blocked', async () => {
  const { d, db } = setup();
  const lock = dbLock(db);
  const tok = await lock.acquire('api', 'other', 60000);
  assert.ok(tok);
  assert.equal((await d.deploy({ unit: 'api', artifact: art('v2'), expectedVersion: 'v1' })).reason, 'locked');
  assert.ok(await lock.acquire('worker2', 'x', 60000));
  await lock.release('api', tok);
  assert.equal((await d.deploy({ unit: 'api', artifact: art('v2'), expectedVersion: 'v1' })).status, 'kept');
});

test('an expired lock is taken over; an injected lock port is used instead of the built-in', async () => {
  const { db, clock } = setup();
  const lock = dbLock(db, clock.now);
  assert.ok(await lock.acquire('u', 'a', 1000));
  clock.sleep(2000);
  assert.ok(await lock.acquire('u', 'b', 1000));
  const calls = [];
  const port = { acquire: async (u) => { calls.push('acq:' + u); return 'T'; }, release: async (u, t) => { calls.push('rel:' + t); } };
  const s = setup({ extra: { lock: port } });
  await s.d.deploy({ unit: 'api', artifact: art('v2'), expectedVersion: 'v1' });
  assert.deepEqual(calls, ['acq:api', 'rel:T']);
});

test('loop breaker: N consecutive reverts trip a gate-style record and further deploys are refused until closed', async () => {
  const { d, web } = setup({ config: { breakerThreshold: 3 } });
  web.healthy = false;
  let last;
  for (const v of ['v2', 'v3', 'v4']) last = await d.deploy({ unit: 'api', artifact: art(v), expectedVersion: 'v1' });
  assert.equal(last.status, 'reverted');
  assert.ok(last.gate, 'gate record opened on third revert');
  web.healthy = true; web.version = 'v5';
  const blocked = await d.deploy({ unit: 'api', artifact: art('v5'), expectedVersion: 'v1' });
  assert.equal(blocked.reason, 'loop_breaker_open');
  await d.closeGate(last.gate);
  assert.equal((await d.deploy({ unit: 'api', artifact: art('v5'), expectedVersion: 'v1' })).status, 'kept');
});

test('a kept deploy resets the breaker count', async () => {
  const { d, web } = setup({ config: { breakerThreshold: 2 } });
  web.healthy = false;
  assert.equal((await d.deploy({ unit: 'api', artifact: art('v2'), expectedVersion: 'v1' })).gate, undefined);
  web.healthy = true; web.version = 'v3';
  assert.equal((await d.deploy({ unit: 'api', artifact: art('v3'), expectedVersion: 'v1' })).status, 'kept');
  web.healthy = false;
  assert.equal((await d.deploy({ unit: 'api', artifact: art('v4'), expectedVersion: 'v3' })).gate, undefined);
});

test('an unverifiable rollback opens a gate record and reports failed', async () => {
  const { d, web } = setup({ deployer: fakeDeployer('v1', { brokenRollback: true }) });
  web.healthy = false;
  const r = await d.deploy({ unit: 'api', artifact: art('v2'), expectedVersion: 'v1' });
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /rollback_unverified/);
  assert.ok(r.gate);
});

test('unlogged mutation: reconcile files a record when live differs from the ledger', async () => {
  const { d, deployer, db } = setup();
  assert.equal((await d.reconcile('api')).status, 'no_baseline');
  await d.deploy({ unit: 'api', artifact: art('v2'), expectedVersion: 'v1' });
  assert.equal((await d.reconcile('api')).status, 'consistent');
  deployer.live = 'hotfix-by-hand';
  const r = await d.reconcile('api');
  assert.equal(r.status, 'unlogged');
  assert.equal(r.live, 'hotfix-by-hand');
  const rec = await rows(db, `SELECT * FROM deploy_records WHERE kind='unlogged'`);
  assert.equal(rec.length, 1);
  assert.match(rec[0].what, /UNLOGGED/);
  assert.equal((await d.ledger('api'))[0].status, 'unlogged');
  assert.equal((await d.reconcile('api')).status, 'consistent'); // baseline moved, no duplicate record
});

test('after a revert, reconcile expects the prior version', async () => {
  const { d, web } = setup();
  web.healthy = false;
  await d.deploy({ unit: 'api', artifact: art('v2'), expectedVersion: 'v1' });
  assert.equal((await d.reconcile('api')).status, 'consistent');
});

test('ledger is complete: every attempt has a row, probes recorded before and after', async () => {
  const { d, db, web } = setup();
  await d.deploy({ unit: 'api', artifact: art('v2'), expectedVersion: 'nope' });
  web.healthy = false;
  await d.deploy({ unit: 'api', artifact: art('v2'), expectedVersion: 'v1' });
  web.healthy = true;
  await d.deploy({ unit: 'api', artifact: art('v2'), expectedVersion: 'v1' });
  const l = (await d.ledger('api')).map(r => r.status).reverse();
  assert.deepEqual(l, ['refused', 'reverted', 'kept']);
  const phases = (await rows(db, `SELECT DISTINCT phase FROM deploy_probe_results`)).map(r => r.phase).sort();
  assert.deepEqual(phases, ['after', 'before']);
});

test('artifact digest mismatch is refused (US-07-R13)', async () => {
  const { d, deployer } = setup();
  const r = await d.deploy({ unit: 'api', artifact: { ...art('v2'), sha256: '0'.repeat(64) }, expectedVersion: 'v1' });
  assert.equal(r.reason, 'artifact_digest_mismatch');
  assert.deepEqual(deployer.calls, []);
});

test('kill switch refuses deploys (US-09-R02), via config row or injected port', async () => {
  const { d, db, deployer } = setup();
  db.raw.exec(`INSERT INTO deploy_config VALUES ('kill_switch','on')`);
  assert.equal((await d.deploy({ unit: 'api', artifact: art('v2'), expectedVersion: 'v1' })).reason, 'kill_switch');
  const s = setup({ extra: { killSwitch: async () => true } });
  assert.equal((await s.d.deploy({ unit: 'api', artifact: art('v2'), expectedVersion: 'v1' })).reason, 'kill_switch');
  assert.deepEqual(deployer.calls, []);
});

test('db-row probes and observe mode', async () => {
  const s = setup();
  s.db.raw.exec(`INSERT INTO deploy_units VALUES ('svc2', '[{"kind":"db","sql":"SELECT COUNT(*) FROM org","expect":">0"}]', 'observe')`);
  s.deployer.live = 'a';
  const r = await s.d.deploy({ unit: 'svc2', artifact: art('b'), expectedVersion: 'a' });
  assert.equal(r.status, 'kept');
  assert.match(r.reason, /observe mode/);
  assert.equal(s.deployer.live, 'b'); // observe keeps without reverting
  s.db.raw.exec(`INSERT INTO org VALUES ('k','v')`);
  s.db.raw.exec(`UPDATE deploy_units SET mode='revert' WHERE unit='svc2'`);
  assert.equal((await s.d.deploy({ unit: 'svc2', artifact: art('c'), expectedVersion: 'b' })).status, 'kept');
});

test('no secret value is stored anywhere, even if an error message carries it', async () => {
  const deployer = fakeDeployer();
  deployer.publish = async () => { throw new Error('auth failed with ' + SECRET); };
  const { d, db } = setup({ deployer });
  const r = await d.deploy({ unit: 'api', artifact: art('v2'), expectedVersion: 'v1' });
  assert.equal(r.status, 'failed');
  const dump = JSON.stringify([
    await rows(db, `SELECT * FROM deploy_ledger`), await rows(db, `SELECT * FROM deploy_records`),
    await rows(db, `SELECT * FROM deploy_probe_results`), await rows(db, `SELECT * FROM deploy_lock`)]);
  assert.ok(!dump.includes(SECRET));
  assert.ok(dump.includes('[redacted]'));
});

test('handle: auth required, POST /deploy, GET /ledger, 409 on refusal', async () => {
  const { d } = setup();
  const req = (method, path, body, tok = SECRET) => new Request('https://x.example' + path, { method, headers: { 'x-deploy-token': tok }, body: body && JSON.stringify(body) });
  assert.equal((await d.handle(req('GET', '/ledger', null, 'wrong'), {})).status, 401);
  assert.equal((await d.handle(req('POST', '/deploy', { unit: 'api', artifact: art('v2'), expectedVersion: 'bad' }))).status, 409);
  const ok = await d.handle(req('POST', '/deploy', { unit: 'api', artifact: art('v2'), expectedVersion: 'v1', actor: 'a' }));
  assert.equal(ok.status, 200);
  const led = await (await d.handle(req('GET', '/ledger?unit=api'))).json();
  assert.equal(led.rows.length, 2);
  assert.equal((await d.handle(req('GET', '/nope'))).status, 404);
  const none = createDeploy({ db: makeDb([MIG]), deployer: fakeDeployer(), fetch: fakeFetch({}), env: {} });
  assert.equal((await none.handle(req('GET', '/ledger', null, ''))).status, 401); // no token configured: refuse everyone
});
