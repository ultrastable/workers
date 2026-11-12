// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Tick-step entries named in pack.json, plus report(). Class A: nothing here reaches outside the organization.
import { all, first, run, iso } from '../../core/kernel/util.js';
import { cfg } from './collect.js';

// Recomputes the daily totals of every day that still has raw events (idempotent: same events, same rows).
export async function rollup({ db, ctx }) {
  const days = await all(db, `SELECT DISTINCT day FROM analytics_events`);
  for (const { day } of days) {
    await run(db, `DELETE FROM analytics_daily WHERE day = ?`, day);
    await run(db, `INSERT INTO analytics_daily (day, path, pageviews, visitors) SELECT day, path, COUNT(*), COUNT(DISTINCT visitor_hash) FROM analytics_events WHERE day = ? GROUP BY path`, day);
    await run(db, `DELETE FROM analytics_sources WHERE day = ?`, day);
    await run(db, `INSERT INTO analytics_sources (day, source, pageviews) SELECT day, COALESCE(utm_source, referrer, '(direct)'), COUNT(*) FROM analytics_events WHERE day = ? GROUP BY 2`, day);
  }
  ctx?.notes?.push(`analytics rollup: ${days.length} day(s)`);
}

// Deletes raw events older than the retention window, only for days already rolled up.
export async function retention({ db, ctx, now, settings }) {
  const s = cfg(settings);
  const cutoff = iso(now() - s.raw_retention_days * 86400e3).slice(0, 10);
  await rollup({ db });
  const r = await run(db, `DELETE FROM analytics_events WHERE day < ? AND day IN (SELECT day FROM analytics_daily)`, cutoff);
  const n = r.meta.changes ?? 0;
  ctx?.notes?.push(`analytics retention: purged ${n} raw event(s) before ${cutoff}`);
  return n;
}

export async function metrics({ db, ctx, now }) {
  const t = now(), today = iso(t).slice(0, 10);
  const pv = (await first(db, `SELECT COALESCE(SUM(pageviews),0) AS n FROM analytics_daily WHERE day >= ?`, iso(t - 7 * 86400e3).slice(0, 10))).n;
  const vis = (await first(db, `SELECT COUNT(DISTINCT visitor_hash) AS n FROM analytics_events WHERE day = ?`, today)).n;
  const raw = (await first(db, `SELECT COUNT(*) AS n FROM analytics_events`)).n;
  await run(db, `INSERT INTO analytics_metrics (at, pageviews_7d, visitors_today, raw_events, purged) VALUES (?,?,?,?,0)`, iso(t), pv, vis, raw);
  ctx?.notes?.push(`analytics metrics: ${pv} views in 7 days, ${vis} visitors today, ${raw} raw events`);
}

// Read side for the organization's own dashboard.
export async function report({ db, now = Date.now, days = 7, limit = 5 }) {
  const since = iso(now() - days * 86400e3).slice(0, 10);
  return {
    since,
    pageviews: (await first(db, `SELECT COALESCE(SUM(pageviews),0) AS n FROM analytics_daily WHERE day >= ?`, since)).n,
    top_pages: await all(db, `SELECT path, SUM(pageviews) AS pageviews FROM analytics_daily WHERE day >= ? GROUP BY path ORDER BY pageviews DESC, path LIMIT ?`, since, limit),
    top_sources: await all(db, `SELECT source, SUM(pageviews) AS pageviews FROM analytics_sources WHERE day >= ? GROUP BY source ORDER BY pageviews DESC, source LIMIT ?`, since, limit),
  };
}
