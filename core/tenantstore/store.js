// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// core/tenantstore (spec: US-SPEC-25). TenantStore: the one door to a tenant's data. SqlPort contract (every adapter implements it):
//   sql.exec(text, params[]) -> { rows: object[], rowsRead: number, rowsWritten: number }
// The tenant's store is private to the tenant (one Durable Object, one SQLite file, one D1 database, one Postgres schema),
// which is the sandbox; the guard meters it; hot reads can be served from a cache port and survive a spent budget.
import { BudgetGuard, BudgetError, DEFAULT_BUDGET } from './budget.js';
import { VectorIndex } from './vector.js';
import { Rollups } from './rollup.js';

const isWrite = (t) => !/^\s*(select|with|pragma|explain)\b/i.test(t);

export class TenantStore {
  constructor({ tenantId, sql, budget = DEFAULT_BUDGET, now = () => new Date(), cache = null }) {
    if (!tenantId) throw new Error('tenantId required');
    this.tenantId = tenantId; this.sql = sql; this.cache = cache;
    this.guard = new BudgetGuard(sql, { budget, now });
    this.vectors = new VectorIndex(sql, this.guard);
    this.rollups = new Rollups(sql, this.guard, now);
  }
  // Metered statement. Refuses when the budget is spent or when one statement read more rows than perQueryReads (a scan).
  query(text, params = []) {
    this.guard.check();
    const r = this.sql.exec(text, params);
    const hot = this.guard.record({ reads: r.rowsRead, writes: r.rowsWritten });
    if (!isWrite(text) && r.rowsRead > this.guard.budget.perQueryReads) { const e = new Error('query_too_wide'); e.code = 'query_too_wide'; e.rowsRead = r.rowsRead; throw e; }
    return { rows: r.rows, rowsRead: r.rowsRead, rowsWritten: r.rowsWritten, hot };
  }
  // Hot read: serve from cache; recompute on miss; if the budget is spent, serve the stale value instead of failing.
  async cached(key, ttlSec, compute) {
    const k = `t:${this.tenantId}:${key}`;
    const hit = this.cache ? await this.cache.get(k) : null;
    if (hit && JSON.parse(hit).exp > Date.now()) return JSON.parse(hit).v;
    try {
      const v = await compute(this);
      if (this.cache) await this.cache.put(k, JSON.stringify({ v, exp: Date.now() + ttlSec * 1000 }), { expirationTtl: Math.max(60, ttlSec * 10) });
      return v;
    } catch (e) {
      if (e instanceof BudgetError && hit) return JSON.parse(hit).v;
      throw e;
    }
  }
  status() { return { tenantId: this.tenantId, ...this.guard.snapshot(), vectors: this.vectors.count() }; }
}
export { BudgetError, DEFAULT_BUDGET };
