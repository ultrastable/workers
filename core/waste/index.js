// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Waste agent (US-SPEC-09): finds spend that produces nothing. Call-ledger rules (W-ERR, W-RATE, W-META, W-YIELD) live in core/yield;
// this module runs them and adds the two rules that need no call ledger: W-BACKLOG (a queue is deeper than it should be) and
// W-STALL (a counter that should move has not). Gauges are ports: ctx.gauges = { name: { read(): number, kind: 'backlog'|'stall', limit } }
// or limit from config.gauge_limits[name]. Findings open one item, re-open on recurrence, close after N clean runs.
// Calibration (probing model routes) is core/router/calibration.js.
import { sweep as yieldSweep, cfg as yieldCfg } from '../yield/index.js';
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const nowMs = ctx => { const v = ctx.now(); return v instanceof Date ? v.getTime() : v; };
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();

/** Pure rule: a gauge reading breaches when value >= limit. */
export function evaluateGauges(readings, limits) {
  const out = [];
  for (const r of readings) {
    const limit = limits[r.name] ?? r.limit;
    if (limit == null || r.value == null || r.value < limit) continue;
    const rule = r.kind === 'stall' ? 'W-STALL' : 'W-BACKLOG';
    out.push({ key: rule + '|' + r.name, rule, gauge: r.name, value: r.value,
      title: `WASTE ${rule}: ${r.name} is ${r.value} (limit ${limit})`,
      body: r.kind === 'stall' ? `${r.name} has not moved for ${r.value} units. Find the blocked stage and unblock it. Closing probe: ${r.name} below ${limit}.` : `${r.name} holds ${r.value} waiting units. Spend there is not producing output. Closing probe: ${r.name} below ${limit}.` });
  }
  return out;
}

async function readGauges(ctx) {
  const out = [];
  for (const [name, g] of Object.entries(ctx.gauges || {})) {
    try { out.push({ name, kind: g.kind || 'backlog', limit: g.limit, value: Number(await g.read()) }); }
    catch { out.push({ name, kind: g.kind || 'backlog', limit: g.limit, value: null }); } // an unreadable gauge never files a finding
  }
  return out;
}

/** One waste run: the call-ledger sweep, then the gauge rules. */
export async function wasteRun(ctx) {
  const base = await yieldSweep(ctx), c = yieldCfg(ctx);
  const ts = iso(nowMs(ctx)), found = evaluateGauges(await readGauges(ctx), c.gauge_limits || {});
  const hit = new Set(found.map(f => f.key));
  let filed = base.filed, closed = base.closed;
  for (const f of found) {
    const ex = await first(ctx.db, 'SELECT key, item_id, status FROM waste_gauge_findings WHERE key = ?', f.key);
    if (!ex) {
      const itemId = 'WST-' + f.key.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60);
      await run(ctx.db, `INSERT OR IGNORE INTO items (id, title, kind, owner_role, done_check, closing_probe, priority, status) VALUES (?,?,'fix',?,?,?,60,'open')`,
        itemId, f.title, c.owner_role, f.body, 'rule ' + f.rule + ' no longer fires for ' + f.gauge);
      await run(ctx.db, 'INSERT INTO waste_gauge_findings (key, rule, gauge, first_seen, last_seen, value, item_id) VALUES (?,?,?,?,?,?,?)', f.key, f.rule, f.gauge, ts, ts, f.value, itemId);
      filed++;
    } else {
      await run(ctx.db, "UPDATE waste_gauge_findings SET last_seen=?, clean_runs=0, value=?, status='open' WHERE key=?", ts, f.value, f.key);
      if (ex.status === 'closed') await run(ctx.db, "UPDATE items SET status='open', disposition=NULL, updated_at=datetime('now') WHERE id=?", ex.item_id);
    }
  }
  for (const o of await all(ctx.db, "SELECT key, item_id, clean_runs FROM waste_gauge_findings WHERE status='open'")) {
    if (hit.has(o.key)) continue;
    const n = +o.clean_runs + 1;
    if (n >= c.clean_runs_to_close) {
      await run(ctx.db, "UPDATE waste_gauge_findings SET status='closed', clean_runs=? WHERE key=?", n, o.key);
      await run(ctx.db, "UPDATE items SET status='done', disposition='closed: rule clean for ' || ? || ' runs', updated_at=datetime('now') WHERE id=? AND status='open'", n, o.item_id);
      closed++;
    } else await run(ctx.db, 'UPDATE waste_gauge_findings SET clean_runs=? WHERE key=?', n, o.key);
  }
  return { filed, closed, ledger_findings: base.findings, gauge_findings: found.length };
}

/** Where the money went: top spenders over the window with the share that was wasted on errors. */
export async function report(ctx, { top = 5 } = {}) {
  const c = yieldCfg(ctx), since = new Date(nowMs(ctx) - c.window_days * 86400000).toISOString().slice(0, 10);
  const rows = await all(ctx.db, `SELECT source, purpose, SUM(calls) calls, SUM(errors) errors, SUM(cost) cost,
    SUM(CASE WHEN calls > 0 THEN errors * cost / calls ELSE 0 END) wasted FROM yield_calls WHERE day >= ? GROUP BY source, purpose ORDER BY cost DESC LIMIT ?`, since, top);
  const total = rows.reduce((a, r) => a + r.cost, 0);
  return { window_days: c.window_days, total_cost: total, top: rows.map(r => ({ source: r.source, purpose: r.purpose, calls: +r.calls, cost: +r.cost, wasted: +r.wasted, share: total ? r.cost / total : 0 })) };
}
