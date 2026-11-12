// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tests for packs/cloud (US-SPEC-21 class D) over the real core/deploy with a fake deployer and fake fetch. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../../core/_shared/testdb.js';
import { KERNEL_DIR } from '../../core/kernel/testkit.js';
import { createPacks, validateManifest, loadManifest, MIGRATIONS_DIR } from '../../core/packs/index.js';
import { createDeploy } from '../../core/deploy/index.js';
import { requestDeploy, guardPort } from './index.js';

const DIR = fileURLToPath(new URL('./', import.meta.url));
const MIG = fileURLToPath(new URL('./migrations/', import.meta.url));
const DEPLOY_MIG = fileURLToPath(new URL('../../core/deploy/migrations/', import.meta.url));
const T0 = Date.parse('2026-11-11T10:00:00Z');
const rows = (db, sql, ...a) => db.raw.prepare(sql).all(...a).map(r => ({ ...r }));
const one = (db, sql, ...a) => db.raw.prepare(sql).get(...a);

function fakeDeployer(live = 'v1') {
  const s = { live, calls: [] };
  return Object.assign(s, {
    async liveVersion() { return s.live; },
    async publish(unit, artifact) { s.calls.push(`publish ${artifact.version}`); s.live = artifact.version; return { version: artifact.version }; },
    async rollback(unit, to) { s.calls.push(`rollback ${to}`); s.live = to; },
  });
}

async function setup({ rung = 'delegated', healthy = true } = {}) {
  const db = makeDb([KERNEL_DIR, MIGRATIONS_DIR, DEPLOY_MIG, MIG]);
  const clock = { t: T0 };
  const web = { healthy };
  const deployer = fakeDeployer();
  const fetch = async () => new Response(web.healthy ? '{"ok":true}' : 'down', { status: web.healthy ? 200 : 500 });
  const deploy = createDeploy({ db, deployer, fetch, now: () => clock.t, sleep: async ms => { clock.t += ms; }, config: { windowMs: 4000, intervalMs: 2000 },
    probes: { web: [{ kind: 'http', url: 'https://svc.example/health', contains: ['"ok":true'] }] } });
  const deploys = { cloudflare: deploy, gcp: deploy };
  const artifacts = async () => ({ body: 'code' });
  const settings = { units: [{ provider: 'cloudflare', unit: 'web' }], deploys, artifacts };
  const packs = createPacks({ db, now: () => clock.t, config: { packs: { cloud: settings } }, channels: { cloud: guardPort({ db, deploys, artifacts, now: () => clock.t }) } });
  const m = loadManifest(DIR);
  assert.deepEqual((await packs.register(m, { dir: DIR })).errors, undefined);
  assert.equal((await packs.enablePack('cloud', { by: 'owner', cardText: m.enable_gate })).ok, true);
  if (rung) db.raw.prepare(`INSERT INTO trust_ledger (surface, action_class, rung, reliability, outcomes) VALUES ('pack:cloud','deploy',?,1,50)`).run(rung);
  const loop = async name => {
    const step = (await packs.packSteps()).find(x => x.name === `pack:cloud:${name}`);
    const ctx = { tickId: 6, errors: [], notes: [], now: clock.t };
    await step.run(db, ctx);
    assert.deepEqual(ctx.errors, []);
    return ctx;
  };
  const req = (version, over = {}) => requestDeploy({ db, now: () => clock.t, settings, provider: 'cloudflare', unit: 'web', version, expectedVersion: 'v1', by: 'agent', ...over });
  return { db, packs, loop, deployer, web, req, clock, settings };
}

test('manifest is valid as class D, cloud_ prefixed tables, probes run', () => {
  const m = loadManifest(DIR);
  assert.deepEqual(validateManifest(m, { tenantNames: ['acme'] }), []);
  assert.equal(m.class, 'D');
  const db = makeDb([KERNEL_DIR, MIGRATIONS_DIR, DEPLOY_MIG, MIG]);
  const sql = readFileSync(new URL('./migrations/0001_cloud.sql', import.meta.url), 'utf8');
  db.raw.exec(sql); db.raw.exec(sql);
  assert.deepEqual(rows(db, `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cloud_%'`).map(r => r.name).sort(), ['cloud_metrics', 'cloud_requests', 'cloud_units']);
  for (const g of [...m.charter.guard_metrics, m.charter.primary_metric]) db.raw.prepare(g.read_probe).get();
});

test('requests: unlisted units, unconfigured providers, bad names and versions are refused; duplicates queue once', async () => {
  const { req, db } = await setup();
  assert.equal((await req('v2', { unit: 'other' })).reason, 'unit_not_listed');
  assert.equal((await req('v2', { provider: 'aws' })).reason, 'provider_not_configured');
  assert.equal((await req('v2', { unit: '../x' })).reason, 'unit_name_invalid');
  assert.equal((await req('v 2')).reason, 'version_invalid');
  assert.equal((await req('v2', { by: '' })).reason, 'requested_by_required');
  assert.equal((await req('v2', { expectedVersion: '' })).reason, 'expected_version_required');
  assert.equal((await req('v2')).queued, true);
  assert.equal((await req('v2')).duplicate, true);
  assert.equal(rows(db, `SELECT * FROM cloud_requests`).length, 1);
});

test('a deploy goes through core/deploy: ledger row, live version moves, request deployed, not repeated', async () => {
  const { db, req, loop, deployer } = await setup();
  await req('v2');
  const ctx = await loop('apply');
  assert.match(ctx.notes.join(' '), /web@v2 deployed/);
  assert.equal(deployer.live, 'v2');
  const r = one(db, `SELECT * FROM cloud_requests`);
  assert.equal(r.status, 'deployed');
  assert.equal(one(db, `SELECT status, to_version FROM deploy_ledger WHERE id = ?`, r.ledger_id).status, 'kept');
  await loop('apply');
  assert.deepEqual(deployer.calls, ['publish v2']);
  await loop('metrics');
  assert.equal(one(db, `SELECT deployed FROM cloud_metrics`).deployed, 1);
  assert.equal(one(db, loadManifest(DIR).charter.primary_metric.read_probe).value, 1);
});

test('below the delegated rung a deploy waits as a card; approving it deploys (class D route kept on approval)', async () => {
  const { db, req, loop, deployer, packs } = await setup({ rung: null });
  await req('v2');
  await loop('apply');
  assert.deepEqual(deployer.calls, []);
  const r = one(db, `SELECT * FROM cloud_requests`);
  assert.equal(r.status, 'awaiting_approval');
  const out = await packs.guard.approve(r.guard_queue_id, { by: 'owner' });
  assert.equal(out.decision, 'sent');
  assert.equal(deployer.live, 'v2');
  assert.equal(one(db, `SELECT status FROM cloud_requests`).status, 'deployed');
});

test('a failing probe reverts: request marked reverted, live version restored, guard metric counts it', async () => {
  const { db, req, loop, deployer, web } = await setup();
  web.healthy = false;
  await req('v2');
  await loop('apply');
  const r = one(db, `SELECT * FROM cloud_requests`);
  assert.equal(r.status, 'reverted');
  assert.match(r.detail, /probe_failed/);
  assert.equal(deployer.live, 'v1');
  assert.deepEqual(deployer.calls, ['publish v2', 'rollback v1']);
  assert.equal(one(db, loadManifest(DIR).charter.guard_metrics[1].read_probe).value, 1);
});

test('a kill switch holds the request queued; nothing deploys', async () => {
  const { db, req, loop, deployer, packs } = await setup();
  await packs.setSwitch('channel:cloud', true, 'test');
  await req('v2');
  const ctx = await loop('apply');
  assert.match(ctx.notes.join(' '), /held: kill_switch_channel/);
  assert.equal(one(db, `SELECT status FROM cloud_requests`).status, 'queued');
  assert.deepEqual(deployer.calls, []);
});

test('inventory files an item when a unit changed outside the deploy path, and is clean otherwise', async () => {
  const { db, req, loop, deployer } = await setup();
  await req('v2'); await loop('apply');
  await loop('inventory');
  assert.equal(one(db, `SELECT consistent FROM cloud_units`).consistent, 1);
  deployer.live = 'v9';                                                      // someone changed it by hand
  const ctx = await loop('inventory');
  assert.match(ctx.notes.join(' '), /1 unlogged/);
  assert.equal(one(db, `SELECT consistent FROM cloud_units`).consistent, 0);
  assert.equal(rows(db, `SELECT id FROM items WHERE id LIKE 'CLOUDUNLOGGED-%'`).length, 1);
  assert.equal(one(db, loadManifest(DIR).charter.guard_metrics[0].read_probe).value, 1);
});
