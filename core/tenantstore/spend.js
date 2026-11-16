// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Spend probe: turns tenant usage into an estimated monthly Cloudflare bill and a status. ESTIMATES from prices.json (list prices, as_of date),
// never a bill. Because every tenant is hard-capped by its BudgetGuard, the worst case is computable up front (worstCase), not just observed.
import { readFileSync } from 'node:fs';
const PRICES = JSON.parse(readFileSync(new URL('./prices.json', import.meta.url), 'utf8'));
export const prices = () => PRICES;

const over = (used, included, perMillion) => Math.max(0, used - included) / 1e6 * perMillion;

// usage: { reads, writes, requests, storageBytes, vecDims } summed across tenants for one month. Durable Object SQLite pricing.
export function estimateMonth(usage, p = PRICES) {
  const d = p.do_sqlite;
  const parts = {
    base: p.workers_paid_base_month,
    rows_read: over(usage.reads || 0, d.rows_read.included_month, d.rows_read.per_million),
    rows_written: over(usage.writes || 0, d.rows_written.included_month, d.rows_written.per_million),
    requests: over(usage.requests || 0, d.requests.included_month, d.requests.per_million),
    storage: Math.max(0, (usage.storageBytes || 0) / 2 ** 30 - d.storage_gb_month.included) * d.storage_gb_month.per_gb,
    vectorize_queries: over(usage.vecDims || 0, p.vectorize.queried_dimensions.included_month, p.vectorize.queried_dimensions.per_million) * (usage.useVectorize ? 1 : 0),
  };
  return { parts, total: Object.values(parts).reduce((a, b) => a + b, 0), estimate: true, pricesAsOf: p.as_of };
}

// Worst case if every tenant spends its whole monthly budget (this is the hard bound, because the guard refuses past it).
export function worstCase(tenantBudgets, p = PRICES) {
  const sum = (f) => tenantBudgets.reduce((a, b) => a + b.month[f], 0);
  return estimateMonth({ reads: sum('reads'), writes: sum('writes'), requests: sum('requests'), storageBytes: tenantBudgets.reduce((a, b) => a + (b.maxStorageBytes || 0), 0) }, p);
}

// snapshots: [{ tenantId, month: {reads,writes,requests,vec_dims}, storageBytes }]; ceiling: USD per month the owner accepts.
export function probe(snapshots, { ceilingUsd = 8, dayOfMonth, daysInMonth = 30, p = PRICES } = {}) {
  const tot = snapshots.reduce((a, s) => ({ reads: a.reads + s.month.reads, writes: a.writes + s.month.writes, requests: a.requests + s.month.requests, vecDims: a.vecDims + (s.month.vec_dims || 0), storageBytes: a.storageBytes + (s.storageBytes || 0) }), { reads: 0, writes: 0, requests: 0, vecDims: 0, storageBytes: 0 });
  const f = daysInMonth / Math.max(1, dayOfMonth || daysInMonth);
  const projected = estimateMonth({ reads: tot.reads * f, writes: tot.writes * f, requests: tot.requests * f, vecDims: tot.vecDims * f, storageBytes: tot.storageBytes }, p);
  const status = projected.total > ceilingUsd ? 'breach' : projected.total > ceilingUsd * 0.8 ? 'warn' : 'ok';
  const top = [...snapshots].sort((a, b) => b.month.reads - a.month.reads).slice(0, 3).map(s => s.tenantId);
  return { status, ceilingUsd, projectedUsd: Number(projected.total.toFixed(2)), parts: projected.parts, topReaders: top, estimate: true, pricesAsOf: p.as_of };
}
