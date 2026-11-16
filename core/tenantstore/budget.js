// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Per-tenant read/write budgets with enforcement. Cloudflare has no native spend cap, so the cap is ours:
// every statement is metered in the tenant's own store (same transaction domain, no cross-store race) and
// refused once a day or month limit is spent. Portable: it only needs the SqlPort (see store.js).

export class BudgetError extends Error {
  constructor(limit, period, used, max, resetsAt) {
    super(`budget_exceeded:${limit}:${period}`);
    this.code = 'budget_exceeded'; this.limit = limit; this.period = period; this.used = used; this.max = max; this.resetsAt = resetsAt;
  }
}

// Two profiles. FREE fits five tenants inside the Workers Free plan's account-wide Durable Object limits (100,000 requests,
// 100,000 rows written and 5,000,000 rows read per day) with headroom; PAID fits the Workers Paid inclusions. A tenant raises
// its cap only through a reviewed change to its budget row, never at runtime.
export const FREE_PLAN_BUDGET = Object.freeze({
  day:   { reads: 1_000_000, writes: 15_000, requests: 15_000, vecDims: 100_000_000 },
  month: { reads: 31_000_000, writes: 465_000, requests: 465_000, vecDims: 3_100_000_000 },
  perQueryReads: 50_000,   // one statement may not read more rows than this (stops scans)
  maxStorageBytes: 200_000_000,
  maxVectors: 20_000,
  warnAt: 0.8,
});
export const PAID_PLAN_BUDGET = Object.freeze({
  day:   { reads: 20_000_000, writes: 200_000, requests: 200_000, vecDims: 400_000_000 },
  month: { reads: 400_000_000, writes: 3_000_000, requests: 3_000_000, vecDims: 4_000_000_000 },
  perQueryReads: 50_000,
  maxStorageBytes: 1_073_741_824,
  maxVectors: 20_000,
  warnAt: 0.8,
});
export const DEFAULT_BUDGET = FREE_PLAN_BUDGET;

const FIELDS = { reads: 'reads', writes: 'writes', requests: 'requests', vecDims: 'vec_dims' };

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS _budget (period TEXT PRIMARY KEY, reads INTEGER NOT NULL DEFAULT 0, writes INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0, vec_dims INTEGER NOT NULL DEFAULT 0, denied INTEGER NOT NULL DEFAULT 0);
`;

const dayKey = (d) => 'd:' + d.toISOString().slice(0, 10);
const monthKey = (d) => 'm:' + d.toISOString().slice(0, 7);
const nextDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
const nextMonth = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();

export class BudgetGuard {
  constructor(sql, { budget = DEFAULT_BUDGET, now = () => new Date(), flushEvery = 25 } = {}) {
    this.mem = new Map(); this.dirty = new Set(); this.pending = 0; this.flushEvery = flushEvery;
    this.sql = sql; this.budget = { ...DEFAULT_BUDGET, ...budget, day: { ...DEFAULT_BUDGET.day, ...budget.day }, month: { ...DEFAULT_BUDGET.month, ...budget.month } };
    this.now = now; this.sql.exec(SCHEMA);
  }
  // Usage is held in memory (a Durable Object is single-threaded and authoritative while alive) and flushed to the _budget table every
  // flushEvery operations, so metering does not itself burn the plan's rows-written allowance. A crash loses at most flushEvery operations.
  _row(period) {
    if (!this.mem.has(period)) this.mem.set(period, { ...(this.sql.exec('SELECT * FROM _budget WHERE period=?', [period]).rows[0] || { period, reads: 0, writes: 0, requests: 0, vec_dims: 0, denied: 0 }) });
    return this.mem.get(period);
  }
  usage() { const t = this.now(); return { day: this._row(dayKey(t)), month: this._row(monthKey(t)) }; }
  check() {
    const t = this.now(), u = this.usage();
    for (const [scope, key, resets] of [['day', dayKey(t), nextDay(t)], ['month', monthKey(t), nextMonth(t)]]) {
      for (const [name, col] of Object.entries(FIELDS)) {
        const used = u[scope][col], max = this.budget[scope][name];
        if (used >= max) { this._deny(key); if (++this.pending >= this.flushEvery) this.flush(); throw new BudgetError(name, scope, used, max, resets); }
      }
    }
  }
  record({ reads = 0, writes = 0, requests = 1, vecDims = 0 }) {
    const u = this.usage();
    for (const r of [u.day, u.month]) { r.reads += reads; r.writes += writes; r.requests += requests; r.vec_dims += vecDims; this.dirty.add(r.period); }
    if (++this.pending >= this.flushEvery) this.flush();
    return this.warn();
  }
  flush() {
    for (const period of this.dirty) {
      const r = this.mem.get(period);
      this.sql.exec('INSERT OR REPLACE INTO _budget(period,reads,writes,requests,vec_dims,denied) VALUES(?,?,?,?,?,?)', [period, r.reads, r.writes, r.requests, r.vec_dims, r.denied]);
    }
    this.dirty.clear(); this.pending = 0;
  }
  warn() {
    const u = this.usage(), w = this.budget.warnAt; let hot = false;
    for (const scope of ['day', 'month']) for (const [name, col] of Object.entries(FIELDS)) if (u[scope][col] >= this.budget[scope][name] * w) hot = true;
    return hot;
  }
  _deny(key) { this._row(key).denied += 1; this.dirty.add(key); }
  snapshot() { const u = this.usage(); return { day: u.day, month: u.month, budget: { day: this.budget.day, month: this.budget.month } }; }
}
