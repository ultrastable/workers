// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Observability: the organization sees itself. Ingest structured events, compute error ratio and latency per source, and raise one work item per degraded source.
// Ports: ctx = { db, now(), config }. Secrets and bodies are never stored: detail is truncated and scrubbed of token-like strings.
const DEFAULTS = { window_minutes: 60, min_events: 20, error_ratio: 0.2, p95_ms: 5000, owner_role: 'operations' };
export const cfg = ctx => ({ ...DEFAULTS, ...(ctx.config || {}) });
const nowMs = ctx => { const v = ctx.now(); return v instanceof Date ? v.getTime() : v; };
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const scrub = s => String(s || '').replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(0, 200);
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];

export async function ingest(ctx, ev) {
  const ok = ev.outcome === 'ok' || (ev.outcome == null && ev.status < 400);
  await ctx.db.prepare('INSERT INTO observe_events (at,source,route,status,duration_ms,outcome,detail) VALUES (?,?,?,?,?,?,?)')
    .bind(iso(nowMs(ctx)), ev.source, ev.route || null, ev.status ?? null, ev.durationMs ?? null, ok ? 'ok' : 'error', ev.detail ? scrub(ev.detail) : null).run();
}
export const p95 = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; };

/** Summarize the window per source and file one open item per degraded source (idempotent by item id). */
export async function evaluate(ctx) {
  const c = cfg(ctx), since = iso(nowMs(ctx) - c.window_minutes * 60000);
  const rows = await all(ctx.db, 'SELECT source, outcome, duration_ms FROM observe_events WHERE at >= ?', since);
  const by = {};
  for (const r of rows) { const s = (by[r.source] ||= { n: 0, err: 0, d: [] }); s.n++; if (r.outcome === 'error') s.err++; if (r.duration_ms != null) s.d.push(r.duration_ms); }
  const out = [];
  for (const [source, s] of Object.entries(by)) {
    const ratio = s.err / s.n, lat = p95(s.d);
    const degraded = s.n >= c.min_events && (ratio >= c.error_ratio || (lat != null && lat >= c.p95_ms));
    out.push({ source, events: s.n, error_ratio: ratio, p95_ms: lat, degraded });
    if (degraded) await ctx.db.prepare("INSERT OR IGNORE INTO items (id,title,kind,owner_role,done_check,closing_probe,priority,status) VALUES (?,?,'fix',?,?,?,30,'open')")
      .bind('OBS-' + source.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 50), `${source} degraded: ${(ratio * 100).toFixed(0)}% errors, p95 ${lat ?? 'n/a'} ms over ${s.n} events`, c.owner_role,
        'error ratio and p95 back under thresholds', `error ratio < ${c.error_ratio} and p95 < ${c.p95_ms} ms over ${c.window_minutes} minutes`).run();
  }
  return out;
}
