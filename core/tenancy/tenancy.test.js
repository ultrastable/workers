// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { runTick } from '../src/tick.js';
import {
  registerTenant, tenants, resourceNames, scopedStore, localAccess, httpAccess, handle, isolationProbe, isolationSweep,
  buildAggregate, receiveAggregate, silentTenants, tenancySteps, DEFAULT_LEVEL,
} from './index.js';

const dirs = [fileURLToPath(new URL('./migrations/', import.meta.url))];
const T0 = Date.parse('2026-11-15T12:00:00Z');
const policy = JSON.parse(readFileSync(new URL('../../autonomy/policy.json', import.meta.url), 'utf8'));
const TICK = { org_slug: 't', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy };
const mk = (access, at = T0) => { const t = { at }; return { db: makeDb(dirs), now: () => t.at, t, config: {}, access }; };
const count = async (db, table) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;

test('US-SPEC-10 s7 level 2 is the default: one database and one worker per slug', async () => {
  const ctx = mk();
  const t = await registerTenant(ctx, { slug: 'tool-share', runtime: 'workers' });
  assert.equal(t.level, DEFAULT_LEVEL);
  assert.equal(DEFAULT_LEVEL, 2);
  assert.deepEqual(resourceNames('tool-share'), { database: 'ultrastable-tool-share', worker: 'ultrastable-tool-share' });
  assert.notDeepEqual(resourceNames('a'), resourceNames('b'));
  ctx.t.at += 1000;
  const again = await registerTenant(ctx, { slug: 'tool-share', bundle_sha256: 'abc' });
  assert.equal(again.registered_at, t.registered_at, 'registering twice keeps the first registration');
  assert.equal(again.runtime, 'workers');
  assert.equal((await tenants(ctx.db)).length, 1);
  await assert.rejects(registerTenant(ctx, { slug: 'Bad Slug' }), /slug/);
  await assert.rejects(registerTenant(ctx, { slug: 'x', level: 4 }), /level/);
});

test('US-10-R13 level 2: tenant B has no handle to tenant A, the probe passes and the canary is deleted', async () => {
  const A = makeDb(dirs), B = makeDb(dirs), ctx = mk(localAccess({ a: A, b: B }));
  const r = await isolationProbe(ctx, { a: 'a', b: 'b', level: 2 });
  assert.deepEqual([r.result, r.detail, r.canary_deleted, r.severity], ['pass', 'denied', true, null]);
  assert.equal(await count(A, 'tenancy_canary'), 0, 'the canary is deleted');
  const row = await ctx.db.prepare('SELECT tenant_a, tenant_b, result, canary_deleted FROM tenancy_probes').first();
  assert.deepEqual(row, { tenant_a: 'a', tenant_b: 'b', result: 'pass', canary_deleted: 1 });
});

test('US-10-R13 level 3: a shared database with the tenant id enforced by the scoped store returns zero rows to the other tenant', async () => {
  const shared = makeDb(dirs), ctx = mk(localAccess(() => shared));
  const sa = scopedStore(shared, 'a'), sb = scopedStore(shared, 'b');
  await sa.write('row1', 'private to a', '2026-11-15 12:00:00');
  assert.equal((await sb.read('row1')).length, 0);
  assert.equal(await sb.remove('row1'), 0, 'tenant b cannot delete tenant a\'s row either');
  assert.equal((await sa.read('row1')).length, 1);
  const r = await isolationProbe(ctx, { a: 'a', b: 'b', level: 3 });
  assert.deepEqual([r.result, r.detail], ['pass', 'zero rows']);
  assert.equal(await count(shared, 'tenancy_canary'), 1, 'only the canary is removed, tenant data stays');
});

test('US-10-R13 a read that succeeds across tenants is a severe outcome and opens a priority-0 item; a later pass closes it', async () => {
  const shared = makeDb(dirs);
  const leaky = { ...localAccess(() => shared), readAs: async (_reader, owner, id) => ({ rows: await scopedStore(shared, owner).read(id) }) }; // a policy that forgot the tenant id
  const ctx = mk(leaky);
  const r = await isolationProbe(ctx, { a: 'a', b: 'b', level: 3 });
  assert.deepEqual([r.result, r.severity, r.canary_deleted], ['fail', 'severe', true]);
  const item = await ctx.db.prepare("SELECT priority, status, owner_role, closing_probe FROM items WHERE id='ISOLATION-a-b'").first();
  assert.deepEqual([item.priority, item.status, item.owner_role], [0, 'open', 'operations']);
  assert.ok(item.closing_probe);
  assert.equal((await ctx.db.prepare('SELECT severity FROM tenancy_probes').first()).severity, 'severe');
  ctx.access = localAccess(() => shared); ctx.t.at += 60000;
  assert.equal((await isolationProbe(ctx, { a: 'a', b: 'b', level: 3 })).result, 'pass');
  assert.equal((await ctx.db.prepare("SELECT status FROM items WHERE id='ISOLATION-a-b'").first()).status, 'done');
});

test('US-10-R13 an unreachable tenant is unknown, never a pass; a canary that cannot be deleted files an item', async () => {
  const ctx = mk({ write: async () => { throw new Error('http 502'); }, readAs: async () => ({ denied: true }), remove: async () => 1 });
  const r = await isolationProbe(ctx, { a: 'a', b: 'b' });
  assert.deepEqual([r.result, r.canary_deleted], ['unknown', false]);
  assert.equal(await count(ctx.db, 'items'), 0);
  ctx.access = { write: async () => {}, readAs: async () => ({ denied: true }), remove: async () => { throw new Error('http 500'); } };
  ctx.t.at += 1000;
  const d = await isolationProbe(ctx, { a: 'a', b: 'b' });
  assert.equal(d.result, 'pass');
  assert.equal(d.canary_deleted, false);
  assert.equal((await ctx.db.prepare("SELECT status FROM items WHERE id='ISOLATION-CANARY-a'").first()).status, 'open');
});

test('US-10-R13 over http: tenant B\'s token is refused by tenant A\'s canary route (403) and a shared token is a severe failure', async () => {
  const dbs = { a: makeDb(dirs), b: makeDb(dirs) }, envs = { a: { TENANT_PROBE_TOKEN: 'token-of-a' }, b: { TENANT_PROBE_TOKEN: 'token-of-b' } };
  const fetch = async (url, init) => { const slug = new URL(url).hostname.split('.')[0]; return handle(new Request(url, init), { db: dbs[slug], env: envs[slug], slug, now: T0 }); };
  const cfg = { a: { url: 'https://a.example', tokenEnv: 'TOKEN_A' }, b: { url: 'https://b.example/', tokenEnv: 'TOKEN_B' } };
  const ctx = mk(httpAccess({ fetch, env: { TOKEN_A: 'token-of-a', TOKEN_B: 'token-of-b' }, tenants: cfg }));
  const r = await isolationProbe(ctx, { a: 'a', b: 'b', level: 2 });
  assert.deepEqual([r.result, r.detail, r.canary_deleted], ['pass', 'denied (http 403)', true]);
  assert.equal(await count(dbs.a, 'tenancy_canary'), 0);
  envs.a.TENANT_PROBE_TOKEN = 'token-of-b'; // misconfiguration: both tenants accept one token
  const shared = mk(httpAccess({ fetch, env: { TOKEN_A: 'token-of-b', TOKEN_B: 'token-of-b' }, tenants: cfg }));
  const bad = await isolationProbe(shared, { a: 'a', b: 'b', level: 2 });
  assert.deepEqual([bad.result, bad.severity], ['fail', 'severe']);
  assert.match(bad.detail, /read 1 row/);
});

test('the canary route refuses a missing token (401), a wrong one (403), an unconfigured probe (503) and ignores other paths', async () => {
  const db = makeDb(dirs), env = { TENANT_PROBE_TOKEN: 'right' }, u = 'https://t.example/tenancy/canary/c1';
  assert.equal((await handle(new Request(u), { db, env, slug: 't' })).status, 401);
  assert.equal((await handle(new Request(u, { headers: { authorization: 'Bearer wrong' } }), { db, env, slug: 't' })).status, 403);
  assert.equal((await handle(new Request(u, { headers: { authorization: 'Bearer right' } }), { db, env: {}, slug: 't' })).status, 503);
  assert.equal(await handle(new Request('https://t.example/api/items'), { db, env, slug: 't' }), null);
  const ok = await handle(new Request(u, { headers: { authorization: 'Bearer right' } }), { db, env, slug: 't' });
  assert.deepEqual(await ok.json(), { rows: [] });
});

test('US-10-R13 the sweep probes every ordered tenant pair once a day', async () => {
  const stores = { a: makeDb(dirs), b: makeDb(dirs), c: makeDb(dirs) }, ctx = mk(localAccess(stores));
  for (const slug of ['a', 'b', 'c']) await registerTenant(ctx, { slug });
  const s1 = await isolationSweep(ctx);
  assert.deepEqual([s1.pairs, s1.probed, s1.failed], [6, 6, 0]);
  ctx.t.at += 3 * 3600000;
  assert.equal((await isolationSweep(ctx)).probed, 0, 'not again within the day');
  ctx.t.at += 22 * 3600000;
  assert.equal((await isolationSweep(ctx)).probed, 6);
});

test('US-SPEC-10 s7 the control plane receives counts only: an aggregate carrying anything else is refused', async () => {
  const tenant = { db: makeDb(dirs), now: () => T0, config: {} };
  await runTick(tenant.db, { config: TICK, now: T0 - 600000 });
  await tenant.db.prepare("INSERT INTO items (id, title, owner_role, done_check) VALUES ('X-1','a private title','operations','check')").run();
  const agg = await buildAggregate(tenant);
  assert.deepEqual(agg, { hour: '2026-11-15 12', items_open: 1, items_done: 0, gates_open: 0, ticks_last_hour: 1, ticks_complete_last_hour: 1, predictions_scored: 0 });
  assert.doesNotMatch(JSON.stringify(agg), /private title|X-1/);
  const control = mk();
  assert.deepEqual(await receiveAggregate(control, 'ts', agg), { ok: false, reason: 'unknown_tenant' });
  await registerTenant(control, { slug: 'ts' });
  assert.deepEqual(await receiveAggregate(control, 'ts', agg), { ok: true });
  assert.deepEqual(await receiveAggregate(control, 'ts', { ...agg, items: [{ id: 'X-1', title: 'a private title' }] }), { ok: false, reason: 'unknown_field', fields: ['items'] });
  assert.deepEqual(await receiveAggregate(control, 'ts', { ...agg, items_open: 'a private title' }), { ok: false, reason: 'not_a_count', fields: ['items_open'] });
  assert.equal((await receiveAggregate(control, 'ts', { hour: 'now' })).reason, 'bad_hour');
  assert.equal(await count(control.db, 'tenancy_aggregates'), 1);
  assert.doesNotMatch((await control.db.prepare('SELECT payload FROM tenancy_aggregates').first()).payload, /title/);
  const src = readFileSync(fileURLToPath(new URL('./index.js', import.meta.url)), 'utf8');
  const controlCode = src.slice(src.indexOf('export async function receiveAggregate'), src.indexOf('export function tenancySteps'));
  assert.doesNotMatch(controlCode, /FROM items|FROM gate_cards|FROM predictions/, 'the control-side code has no read path to tenant items');
});

test('a tenant that stops pushing its hourly aggregate is filed, and closes when one arrives', async () => {
  const control = mk();
  await registerTenant(control, { slug: 'ts' });
  assert.deepEqual(await silentTenants(control), []);
  control.t.at += 4 * 3600000;
  assert.deepEqual(await silentTenants(control), ['ts']);
  assert.equal((await control.db.prepare("SELECT status FROM items WHERE id='TENANT-SILENT-ts'").first()).status, 'open');
  await receiveAggregate(control, 'ts', { hour: '2026-11-15 16', items_open: 0 });
  assert.deepEqual(await silentTenants(control), []);
  assert.equal((await control.db.prepare("SELECT status FROM items WHERE id='TENANT-SILENT-ts'").first()).status, 'done');
});

test('tick steps: the control role sweeps, the tenant role pushes on its interval, and no role means nothing runs', async () => {
  const stores = { a: makeDb(dirs), b: makeDb(dirs) }, control = makeDb(dirs);
  const ctx = { db: control, now: () => T0, config: {} };
  await registerTenant(ctx, { slug: 'a' }); await registerTenant(ctx, { slug: 'b' });
  const t = await runTick(control, { config: { ...TICK, tenancy: { role: 'control' } }, now: T0, extraSteps: tenancySteps({ access: localAccess(stores) }) });
  assert.equal(t.errors.length, 0);
  assert.match(t.report, /tenancy: 2 isolation probe\(s\), 0 failed/);
  const pushed = [], tenantDb = makeDb(dirs), steps = tenancySteps({ push: async a => { pushed.push(a); } });
  await runTick(tenantDb, { config: { ...TICK, tenancy: { role: 'tenant', push_every_ticks: 2 } }, now: T0, extraSteps: steps });
  await runTick(tenantDb, { config: { ...TICK, tenancy: { role: 'tenant', push_every_ticks: 2 } }, now: T0 + 600000, extraSteps: steps });
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].ticks_last_hour, 2);
  await runTick(tenantDb, { config: TICK, now: T0 + 1200000, extraSteps: steps });
  assert.equal(pushed.length, 1);
});
