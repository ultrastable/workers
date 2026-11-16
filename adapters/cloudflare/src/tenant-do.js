// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Cloudflare adapter for the tenant store: one SQLite-backed Durable Object per tenant (the sandbox), addressed by tenant id.
// Cloudflare-only imports live here, never in core/. The DO reports rowsRead/rowsWritten per cursor, which feeds the BudgetGuard.
// STATUS: tested against a fake ctx.storage.sql (tenant-do.test.js); NOT yet deployed to a real account.
import { TenantStore, DEFAULT_BUDGET } from '../../../core/tenantstore/store.js';

// Wraps ctx.storage.sql. A SELECT is drained row by row and aborted once the cursor's rowsRead passes the per-query cap, so a runaway scan stops early.
export function doSqlPort(sqlStorage, perQueryReads = DEFAULT_BUDGET.perQueryReads) {
  return {
    exec(text, params = []) {
      const cur = sqlStorage.exec(text, ...params), rows = [];
      for (const r of cur) { rows.push(r); if (cur.rowsRead > perQueryReads * 2) break; } // hard stop; TenantStore then refuses and charges
      return { rows, rowsRead: cur.rowsRead ?? rows.length, rowsWritten: cur.rowsWritten ?? 0 };
    },
  };
}

// Durable Object class, built on the platform's DurableObject base (passed in, so this file imports nothing Cloudflare-only and tests run in Node).
// RPC works only on a class that extends DurableObject, which is why the entry file calls makeTenantDO(DurableObject).
export const makeTenantDO = (Base) => class TenantDO extends Base {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx; this.env = env;
    this.budgetFor = env.TENANT_BUDGETS ? JSON.parse(env.TENANT_BUDGETS) : {};
  }
  store(tenantId) {
    if (!this._store) this._store = new TenantStore({ tenantId, sql: doSqlPort(this.ctx.storage.sql, (this.budgetFor[tenantId] || DEFAULT_BUDGET).perQueryReads), budget: this.budgetFor[tenantId] || DEFAULT_BUDGET, cache: this.env.HOT_KV || null });
    return this._store;
  }
  // RPC methods (Workers RPC): the caller never gets raw SQL access across tenants because it can only reach its own stub.
  // Errors become data ({ error: { code, ... } }) because a thrown custom error loses its fields across the RPC boundary.
  _do(tenantId, fn) {
    try { return { ok: true, value: fn(this.store(tenantId)) }; }
    catch (e) { return { ok: false, error: { code: e.code || 'error', message: String(e.message || e), limit: e.limit, period: e.period, resetsAt: e.resetsAt } }; }
  }
  query(tenantId, text, params) { return this._do(tenantId, s => s.query(text, params)); }
  vectorUpsert(tenantId, id, v, o) { return this._do(tenantId, s => s.vectors.upsert(id, v, o) ?? true); }
  vectorQuery(tenantId, v, o) { return this._do(tenantId, s => s.vectors.query(v, o)); }
  rollupAdd(tenantId, name, key, d) { return this._do(tenantId, s => s.rollups.add(name, key, d) ?? true); }
  rollupGet(tenantId, name, key) { return this._do(tenantId, s => s.rollups.get(name, key)); }
  status(tenantId) { return this._do(tenantId, s => ({ ...s.status(), storageBytes: this.ctx.storage.sql.databaseSize })); }
};

// Router: one stub per tenant, never a shared namespace id. Tenant ids are validated so a caller cannot reach another tenant's object.
export function tenantStub(env, tenantId) {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(tenantId)) throw new Error('bad_tenant_id');
  return env.TENANT.get(env.TENANT.idFromName(tenantId));
}
