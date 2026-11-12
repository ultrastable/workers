// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Port contract for the Google Cloud adapter (issue #48). Each port the core consumes (db, deployer, lock, fetch, now,
// sleep, killSwitch; see core/deploy/README.md) is exercised here through its GCP implementation, offline:
// the db port is the SQLite handle, the deployer port is the Cloud Run deployer over a fake Cloud Run Admin API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../sqlite/d1-sqlite.js';
import { cloudRunDeployer } from '../deployer.js';
import { createDeploy, dbLock } from '../../../core/deploy/index.js';

const DEPLOY_MIG = fileURLToPath(new URL('../../../core/deploy/migrations', import.meta.url));
const TOKEN = 'gcp-token-value-123';

// A fake Cloud Run Admin API: one service, revisions advance on a template PATCH, traffic PATCH selects a revision.
function fakeCloudRun() {
  const s = { live: 'rev-1', n: 1, calls: [], healthy: true };
  s.fetch = async (url, init) => {
    s.calls.push(init.method);
    if (init.method === 'PATCH') {
      const b = JSON.parse(init.body);
      if (b.traffic) s.live = b.traffic[0].revision; else s.live = 'rev-' + (++s.n);
      return Response.json({ name: 'operations/op' });
    }
    return Response.json({ latestReadyRevision: s.live });
  };
  // The service health endpoint reports the live revision, so the version probe can confirm it.
  s.health = async () => (s.healthy ? new Response(JSON.stringify({ ok: true, version: s.live }), { status: 200 }) : new Response('down', { status: 500 }));
  return s;
}

function setup(over = {}) {
  const db = openDb(':memory:', DEPLOY_MIG);
  const run = fakeCloudRun();
  let t = Date.parse('2026-11-12T00:00:00Z');
  const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
  const deployer = cloudRunDeployer({ fetch: run.fetch, config: { project: 'p', region: 'r' }, env: { GCP_ACCESS_TOKEN: TOKEN } });
  const d = createDeploy({ db, deployer, fetch: run.health, now: clock.now, sleep: clock.sleep, env: { GCP_ACCESS_TOKEN: TOKEN },
    config: { windowMs: 4000, intervalMs: 2000 },
    probes: { api: [{ kind: 'http', url: 'https://svc.example/health', contains: ['"ok":true'], version: true }] }, ...over });
  return { db, run, d, clock };
}
const art = (v) => ({ version: v, body: 'image-' + v });

test('db port: the SQLite handle honours the D1 surface (bind, all, first, run meta)', async () => {
  const db = openDb(':memory:');
  db.raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const ins = await db.prepare('INSERT INTO t (v) VALUES (?)').bind('a').run();
  assert.equal(ins.meta.changes, 1);
  assert.equal(ins.meta.last_row_id, 1);
  assert.deepEqual(await db.prepare('SELECT v FROM t WHERE id=?').bind(1).first(), { v: 'a' });
  assert.equal(await db.prepare('SELECT v FROM t WHERE id=?').bind(99).first(), null);
  const all = await db.prepare('SELECT * FROM t').all();
  assert.deepEqual(all.results, [{ id: 1, v: 'a' }]);
  assert.equal((await db.prepare('DELETE FROM t WHERE id=?').bind(99).run()).meta.changes, 0);
  db.close();
});

test('db port: migrations are additive and idempotent when loaded twice', async () => {
  const db = openDb(':memory:', DEPLOY_MIG);
  db.raw.exec(`INSERT INTO deploy_config VALUES ('k','v')`);
  const again = openDb(':memory:', DEPLOY_MIG);
  assert.equal((await again.prepare('SELECT COUNT(*) AS n FROM deploy_ledger').first()).n, 0);
  assert.equal((await db.prepare(`SELECT value FROM deploy_config WHERE key='k'`).first()).value, 'v');
  db.close(); again.close();
});

test('lock port: exclusive per unit, independent across units, expires, releases only with its own token', async () => {
  const db = openDb(':memory:', DEPLOY_MIG);
  let t = 1_000_000;
  const lock = dbLock(db, () => t);
  const a = await lock.acquire('api', 'agent-a', 1000);
  assert.ok(a);
  assert.equal(await lock.acquire('api', 'agent-b', 1000), null);
  assert.ok(await lock.acquire('web', 'agent-b', 1000));
  await lock.release('api', 'wrong-token');
  assert.equal(await lock.acquire('api', 'agent-b', 1000), null);
  t += 1001; // expired
  const b = await lock.acquire('api', 'agent-b', 1000);
  assert.ok(b && b !== a);
  await lock.release('api', b);
  assert.ok(await lock.acquire('api', 'agent-c', 1000));
  db.close();
});

test('deployer port: a passing probe keeps the Cloud Run revision and releases the lock', async () => {
  const { d, run, db } = setup();
  const r = await d.deploy({ unit: 'api', artifact: art('rev-x'), expectedVersion: 'rev-1', actor: 'agent-a' });
  assert.equal(r.status, 'kept');
  assert.equal(r.toVersion, 'rev-2');
  assert.equal(run.live, 'rev-2');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM deploy_lock').first()).n, 0);
  const [row] = await d.ledger('api');
  assert.equal(row.from_version, 'rev-1'); assert.equal(row.to_version, 'rev-2');
  db.close();
});

test('deployer port: a failing probe rolls Cloud Run traffic back to the previous revision', async () => {
  const { d, run, db } = setup();
  run.healthy = false;
  const r = await d.deploy({ unit: 'api', artifact: art('rev-x'), expectedVersion: 'rev-1', actor: 'a' });
  assert.equal(r.status, 'reverted');
  assert.match(r.reason, /probe_failed/);
  assert.equal(run.live, 'rev-1');
  assert.equal(run.calls.filter(m => m === 'PATCH').length, 2); // publish, rollback
  db.close();
});

test('deployer port: a stale expected version is refused without calling publish', async () => {
  const { d, run, db } = setup();
  const r = await d.deploy({ unit: 'api', artifact: art('rev-x'), expectedVersion: 'rev-0', actor: 'a' });
  assert.equal(r.status, 'refused');
  assert.match(r.reason, /stale_version/);
  assert.equal(run.calls.includes('PATCH'), false);
  db.close();
});

test('killSwitch port and deploy_config row both refuse; the token never reaches the ledger', async () => {
  const s = setup({ killSwitch: async () => true });
  assert.equal((await s.d.deploy({ unit: 'api', artifact: art('x'), expectedVersion: 'rev-1' })).reason, 'kill_switch');
  assert.equal(s.run.calls.length, 0);
  s.db.close();
  const t = setup();
  t.db.raw.exec(`INSERT INTO deploy_config VALUES ('kill_switch','on')`);
  assert.equal((await t.d.deploy({ unit: 'api', artifact: art('x'), expectedVersion: 'rev-1' })).reason, 'kill_switch');
  const rows = (await t.db.prepare('SELECT * FROM deploy_ledger').all()).results;
  assert.ok(rows.length >= 1 && !JSON.stringify(rows).includes(TOKEN));
  t.db.close();
});

test('now and sleep ports are injected: the probe window advances on the fake clock, not the wall clock', async () => {
  const { d, run, clock, db } = setup();
  run.healthy = false;
  const t0 = clock.now();
  const wall = Date.now();
  await d.deploy({ unit: 'api', artifact: art('x'), expectedVersion: 'rev-1' });
  assert.ok(clock.now() - t0 >= 4000); // the window elapsed on the injected clock
  assert.ok(Date.now() - wall < 2000); // and no real sleeping happened
  db.close();
});
