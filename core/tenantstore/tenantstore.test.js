// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openTenantSql } from '../../adapters/sqlite/tenant-sqlite.js';
import { TenantStore, BudgetError } from './store.js';
import { estimateMonth, worstCase, probe } from './spend.js';
import { PAID_PLAN_BUDGET, FREE_PLAN_BUDGET } from './budget.js';
import { doSqlPort, tenantStub, makeTenantDO } from '../../adapters/cloudflare/src/tenant-do.js';

const mk = (budget = {}, now) => new TenantStore({ tenantId: 'acme', sql: openTenantSql(), budget, now });

test('write budget is a hard cap and resets next day', () => {
  let t = new Date('2026-11-16T10:00:00Z');
  const s = mk({ day: { writes: 3 } }, () => t);
  s.query('CREATE TABLE a(x)');
  for (let i = 0; i < 3; i++) s.query('INSERT INTO a VALUES(?)', [i]);
  assert.throws(() => s.query('INSERT INTO a VALUES(9)'), (e) => e instanceof BudgetError && e.limit === 'writes' && e.period === 'day');
  t = new Date('2026-11-17T00:00:01Z');
  assert.doesNotThrow(() => s.query('INSERT INTO a VALUES(9)'));
});

test('full-table scan over the per-query cap is refused and charged', () => {
  const s = mk({ perQueryReads: 10 });
  s.query('CREATE TABLE a(x, y)');
  for (let i = 0; i < 50; i++) s.query('INSERT INTO a VALUES(?,?)', [i, i]);
  assert.throws(() => s.query('SELECT * FROM a WHERE y=7'), (e) => e.code === 'query_too_wide');
  s.query('CREATE INDEX ay ON a(y)');
  assert.equal(s.query('SELECT * FROM a WHERE y=7').rows.length, 1); // indexed lookup stays cheap
  assert.ok(s.status().month.reads >= 50);
});

test('rollup replaces a scan with a one-row read', () => {
  const s = mk();
  for (let i = 0; i < 100; i++) s.rollups.add('jobs_by_status', i % 2 ? 'ok' : 'fail');
  const before = s.status().month.reads;
  assert.equal(s.rollups.get('jobs_by_status', 'ok').n, 50);
  assert.equal(s.status().month.reads - before, 1);
});

test('vectors rank by cosine, stay in namespace, and cap at maxVectors', () => {
  const s = mk({ maxVectors: 3 });
  s.vectors.upsert('a', [1, 0, 0], { ns: 'n1', meta: { t: 'a' } });
  s.vectors.upsert('b', [0.9, 0.1, 0], { ns: 'n1' });
  s.vectors.upsert('c', [0, 1, 0], { ns: 'n2' });
  const r = s.vectors.query([1, 0, 0], { k: 2, ns: 'n1' });
  assert.deepEqual(r.map(x => x.id), ['a', 'b']);
  assert.equal(r[0].meta.t, 'a');
  assert.throws(() => s.vectors.upsert('d', [0, 0, 1]), (e) => e.code === 'vector_cap');
  s.vectors.upsert('a', [0, 0, 1]); // overwrite is allowed at the cap
  assert.ok(s.status().month.vec_dims > 0);
});

test('hot read falls back to stale cache when the budget is spent', async () => {
  const m = new Map();
  const cache = { get: async k => m.get(k) ?? null, put: async (k, v) => m.set(k, v) };
  const s = new TenantStore({ tenantId: 'acme', sql: openTenantSql(), budget: { day: { requests: 2 } }, cache });
  assert.equal(await s.cached('k', 0, async () => 1), 1);
  s.query('SELECT 1'); s.query('SELECT 1');
  assert.equal(await s.cached('k', 0, async x => x.query('SELECT 1')), 1); // stale served, no throw
});

test('worst case is bounded by the budgets and spend probe flags a breach', () => {
  const wc = worstCase([PAID_PLAN_BUDGET, PAID_PLAN_BUDGET, PAID_PLAN_BUDGET, PAID_PLAN_BUDGET, PAID_PLAN_BUDGET]);
  assert.ok(wc.estimate && wc.total < 8, 'five tenants at full budget stay under the ceiling: ' + wc.total);
  const heavy = estimateMonth({ reads: 60e9, writes: 100e6, requests: 5e6 });
  assert.ok(heavy.total > 50);
  const p = probe([{ tenantId: 'a', month: { reads: 5e9, writes: 1e6, requests: 1e6 } }, { tenantId: 'b', month: { reads: 9e9, writes: 1e6, requests: 1e6 } }], { dayOfMonth: 5, ceilingUsd: 8 });
  assert.equal(p.status, 'breach'); assert.equal(p.topReaders[0], 'b'); assert.equal(p.estimate, true);
});

test('DO port aborts a runaway cursor and tenant ids are validated', () => {
  const cur = (function* () { for (let i = 0; i < 1000; i++) yield { i }; })();
  cur.rowsRead = 0; const it = { [Symbol.iterator]() { const g = cur; return { next() { const n = g.next(); g.rowsRead++; return n; } }; }, get rowsRead() { return cur.rowsRead; }, rowsWritten: 0 };
  const r = doSqlPort({ exec: () => it }, 10).exec('SELECT 1');
  assert.ok(r.rows.length < 50);
  assert.throws(() => tenantStub({ TENANT: {} }, '../other'), /bad_tenant_id/);
});

test('free profile: five tenants fit inside the free plan account-wide daily limits, and metering is batched', () => {
  const sum = (f) => 5 * FREE_PLAN_BUDGET.day[f];
  assert.ok(sum('requests') <= 100_000 && sum('writes') <= 100_000 && sum('reads') <= 5_000_000);
  const s = new TenantStore({ tenantId: 'acme', sql: openTenantSql(), budget: {} });
  s.query('CREATE TABLE a(x)');
  const before = s.sql.exec('SELECT COUNT(*) n FROM _budget').rows[0].n;
  for (let i = 0; i < 10; i++) s.query('SELECT 1');
  assert.equal(s.sql.exec('SELECT COUNT(*) n FROM _budget').rows[0].n, before, 'no storage writes per operation below flushEvery');
  s.guard.flush();
  assert.equal(s.sql.exec('SELECT requests FROM _budget WHERE period LIKE ?', ['d:%']).rows[0].requests, 11);
});

test('TenantDO runs behind a fake platform base and returns errors as data', () => {
  const sql = openTenantSql();
  const fakeStorage = { sql: { exec: (t, ...p) => { const r = sql.exec(t, p); const it = r.rows[Symbol.iterator](); return { [Symbol.iterator]: () => it, rowsRead: r.rowsRead, rowsWritten: r.rowsWritten }; }, databaseSize: 1 } };
  const DO = makeTenantDO(class { constructor(ctx, env) { this.base = true; } });
  const d = new DO({ storage: fakeStorage }, { TENANT_BUDGETS: JSON.stringify({ acme: { day: { writes: 1 } } }) });
  assert.equal(d.base, true);
  assert.equal(d.query('acme', 'CREATE TABLE a(x)').ok, true);
  assert.equal(d.query('acme', 'INSERT INTO a VALUES(1)').ok, true);
  const e = d.query('acme', 'INSERT INTO a VALUES(2)');
  assert.equal(e.ok, false); assert.equal(e.error.code, 'budget_exceeded');
});
