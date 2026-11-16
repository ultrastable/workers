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

// Durable Object class. Export it from the Worker entry and bind it as TENANT with new_sqlite_classes in wrangler config.
export class TenantDO {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.budgetFor = env.TENANT_BUDGETS ? JSON.parse(env.TENANT_BUDGETS) : {};
  }
  store(tenantId) {
    if (!this._store) this._store = new TenantStore({ tenantId, sql: doSqlPort(this.ctx.storage.sql, (this.budgetFor[tenantId] || DEFAULT_BUDGET).perQueryReads), budget: this.budgetFor[tenantId] || DEFAULT_BUDGET, cache: this.env.HOT_KV || null });
    return this._store;
  }
  // RPC methods (Workers RPC): the caller never gets raw SQL access across tenants because it can only reach its own stub.
  query(tenantId, text, params) { return this.store(tenantId).query(text, params); }
  vectorUpsert(tenantId, id, v, o) { return this.store(tenantId).vectors.upsert(id, v, o); }
  vectorQuery(tenantId, v, o) { return this.store(tenantId).vectors.query(v, o); }
  rollupAdd(tenantId, name, key, d) { return this.store(tenantId).rollups.add(name, key, d); }
  status(tenantId) { return { ...this.store(tenantId).status(), storageBytes: this.ctx.storage.sql.databaseSize }; }
}

// Router: one stub per tenant, never a shared namespace id. Tenant ids are validated so a caller cannot reach another tenant's object.
export function tenantStub(env, tenantId) {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(tenantId)) throw new Error('bad_tenant_id');
  return env.TENANT.get(env.TENANT.idFromName(tenantId));
}
