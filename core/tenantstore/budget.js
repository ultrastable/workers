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

// Defaults are deliberately a small share of the Workers Paid inclusions (25 B reads, 50 M writes per month, account-wide).
// A tenant raises its own cap only through a reviewed change to its budget row, never at runtime.
export const DEFAULT_BUDGET = Object.freeze({
  day:   { reads: 20_000_000, writes: 200_000, requests: 200_000, vecDims: 400_000_000 },
  month: { reads: 400_000_000, writes: 3_000_000, requests: 3_000_000, vecDims: 4_000_000_000 },
  perQueryReads: 50_000,   // one statement may not read more rows than this (stops scans)
  maxStorageBytes: 1_073_741_824,
  maxVectors: 20_000,
  warnAt: 0.8,
});

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
  constructor(sql, { budget = DEFAULT_BUDGET, now = () => new Date() } = {}) {
    this.sql = sql; this.budget = { ...DEFAULT_BUDGET, ...budget, day: { ...DEFAULT_BUDGET.day, ...budget.day }, month: { ...DEFAULT_BUDGET.month, ...budget.month } };
    this.now = now; this.sql.exec(SCHEMA);
  }
  _row(period) {
    return this.sql.exec('SELECT * FROM _budget WHERE period=?', [period]).rows[0] || { reads: 0, writes: 0, requests: 0, vec_dims: 0, denied: 0 };
  }
  usage() { const t = this.now(); return { day: this._row(dayKey(t)), month: this._row(monthKey(t)) }; }
  // Throws BudgetError when any limit is already spent. Called before work starts.
  check() {
    const t = this.now(), u = this.usage();
    for (const [scope, key, resets] of [['day', dayKey(t), nextDay(t)], ['month', monthKey(t), nextMonth(t)]]) {
      for (const [name, col] of Object.entries(FIELDS)) {
        const used = u[scope][col], max = this.budget[scope][name];
        if (used >= max) { this._deny(key); throw new BudgetError(name, scope, used, max, resets); }
      }
    }
  }
  // Adds measured usage after work. Returns true when any limit is past warnAt (the caller may shed load).
  record({ reads = 0, writes = 0, requests = 1, vecDims = 0 }) {
    const t = this.now();
    for (const key of [dayKey(t), monthKey(t)]) {
      this.sql.exec(`INSERT INTO _budget(period,reads,writes,requests,vec_dims) VALUES(?,?,?,?,?)
        ON CONFLICT(period) DO UPDATE SET reads=reads+excluded.reads, writes=writes+excluded.writes, requests=requests+excluded.requests, vec_dims=vec_dims+excluded.vec_dims`,
        [key, reads, writes, requests, vecDims]);
    }
    return this.warn();
  }
  warn() {
    const u = this.usage(), w = this.budget.warnAt; let hot = false;
    for (const scope of ['day', 'month']) for (const [name, col] of Object.entries(FIELDS)) if (u[scope][col] >= this.budget[scope][name] * w) hot = true;
    return hot;
  }
  _deny(key) { this.sql.exec('INSERT INTO _budget(period,denied) VALUES(?,1) ON CONFLICT(period) DO UPDATE SET denied=denied+1', [key]); }
  snapshot() { const u = this.usage(); return { day: u.day, month: u.month, budget: { day: this.budget.day, month: this.budget.month } }; }
}
