// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Yield and waste (cost per useful output). Ports: ctx = { db, now(), config, outputs?(days) }.
// outputs(days) returns the count of useful outputs the organization produced in the last N days (the tenant defines "useful").
// Rules: W-ERR (cost spent on errored calls), W-RATE (error rate), W-META (calls with nothing metered), W-YIELD (cost per output rose).
// A finding opens one work item, re-opens it on recurrence, and closes it after N clean runs. Nothing here names a provider or tenant.

const DEFAULTS = { window_days: 7, err_cost: 20, rate_min_calls: 100, rate_threshold: 0.10, meta_min_calls: 100,
  yield_rise: 1.25, max_new_items: 5, clean_runs_to_close: 3, owner_role: 'operations', unit_label: 'cost units' };
export const cfg = ctx => ({ ...DEFAULTS, ...(ctx.config || {}) });
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const nowMs = ctx => { const v = ctx.now(); return v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v.includes('T') ? v : v.replace(' ', 'T') + 'Z') : v; };
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);

/** Record one metered call (the only write path for the ledger). */
export async function recordCall(ctx, { source, purpose, ok = true, outTokens = 0, cost = 0, day }) {
  const d = day || dayOf(nowMs(ctx));
  await run(ctx.db, `INSERT INTO yield_calls (day, source, purpose, calls, errors, out_tokens, cost) VALUES (?,?,?,1,?,?,?)
    ON CONFLICT(day, source, purpose) DO UPDATE SET calls = calls + 1, errors = errors + excluded.errors,
    out_tokens = out_tokens + excluded.out_tokens, cost = cost + excluded.cost`, d, source, purpose, ok ? 0 : 1, outTokens, cost);
}

/** Pure rule evaluation over aggregated rows; returns findings. */
export function evaluate(rows, c, { cost = 0, outputs = 0, prevCost = 0, prevOutputs = 0 } = {}) {
  const out = [];
  for (const r of rows) {
    const where = `${r.source} / ${r.purpose}`;
    const wasted = r.calls > 0 ? r.errors * r.cost / r.calls : 0;
    if (wasted >= c.err_cost) out.push({ key: `W-ERR|${r.source}|${r.purpose}`, rule: 'W-ERR', source: r.source, purpose: r.purpose, metric: wasted, cost: wasted,
      title: `WASTE W-ERR: ${where} spent ${Math.round(wasted)} ${c.unit_label} on errored calls`,
      body: `${r.calls} calls, ${r.errors} errors. Fix the error source or stop retrying. Closing probe: errored-call cost for ${where} below ${c.err_cost} over ${c.window_days} days.` });
    if (r.calls >= c.rate_min_calls && r.errors / r.calls >= c.rate_threshold) out.push({ key: `W-RATE|${r.source}|${r.purpose}`, rule: 'W-RATE', source: r.source, purpose: r.purpose, metric: r.errors / r.calls, cost: wasted,
      title: `WASTE W-RATE: ${where} error rate ${(100 * r.errors / r.calls).toFixed(1)}% over ${r.calls} calls`,
      body: `Find the error class and fix it at the source. Closing probe: error rate below ${c.rate_threshold * 100}% over ${c.window_days} days with ${c.rate_min_calls}+ calls.` });
    if (r.calls >= c.meta_min_calls && !r.out_tokens && !r.cost) out.push({ key: `W-META|${r.source}|${r.purpose}`, rule: 'W-META', source: r.source, purpose: r.purpose, metric: r.calls, cost: 0,
      title: `WASTE W-META: ${where} made ${r.calls} calls with no tokens or cost recorded`,
      body: 'Cost and output cannot be attributed. Record out_tokens and cost for this purpose. Closing probe: ledger shows non-zero tokens or cost.' });
  }
  const cpo = outputs ? cost / outputs : null, ppo = prevOutputs ? prevCost / prevOutputs : null;
  if (cpo != null && ppo != null && cpo > ppo * c.yield_rise) out.push({ key: 'W-YIELD|org|outputs', rule: 'W-YIELD', source: 'org', purpose: 'yield', metric: cpo, cost: 0,
    title: `WASTE W-YIELD: cost per output rose to ${cpo.toFixed(2)} from ${ppo.toFixed(2)}`,
    body: `Last ${c.window_days} days: ${cost.toFixed(2)} for ${outputs} outputs. Previous window: ${prevCost.toFixed(2)} for ${prevOutputs}. Find the stage whose cost grew without more outputs.` });
  return out;
}

/** One sweep: aggregate, evaluate, file/reopen/close work items. Returns { filed, closed, findings }. */
export async function sweep(ctx) {
  const c = cfg(ctx), now = nowMs(ctx), ts = iso(now);
  const since = dayOf(now - c.window_days * 86400000), prevSince = dayOf(now - 2 * c.window_days * 86400000);
  const rows = (await all(ctx.db, 'SELECT source, purpose, SUM(calls) calls, SUM(errors) errors, SUM(out_tokens) out_tokens, SUM(cost) cost FROM yield_calls WHERE day >= ? GROUP BY source, purpose', since))
    .map(r => ({ ...r, calls: +r.calls, errors: +r.errors, out_tokens: +r.out_tokens, cost: +r.cost }));
  const tot = rows.reduce((a, r) => a + r.cost, 0);
  const prev = +((await first(ctx.db, 'SELECT SUM(cost) s FROM yield_calls WHERE day >= ? AND day < ?', prevSince, since)) || {}).s || 0;
  const outputs = ctx.outputs ? await ctx.outputs(c.window_days) : 0;
  const prevOutputs = ctx.outputs ? Math.max(0, (await ctx.outputs(2 * c.window_days)) - outputs) : 0;
  const found = evaluate(rows, c, { cost: tot, outputs, prevCost: prev, prevOutputs });
  const hit = new Set(found.map(f => f.key));
  let filed = 0, closed = 0;
  for (const f of found) {
    const ex = await first(ctx.db, 'SELECT key, item_id, status FROM yield_findings WHERE key = ?', f.key);
    if (!ex) {
      let itemId = null;
      if (filed < c.max_new_items) {
        itemId = 'YLD-' + f.key.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60);
        await run(ctx.db, `INSERT OR IGNORE INTO items (id, title, kind, owner_role, done_check, closing_probe, priority, status) VALUES (?,?,'fix',?,?,?,60,'open')`,
          itemId, f.title, c.owner_role, f.body, 'rule ' + f.rule + ' no longer fires for ' + f.key);
        filed++;
      }
      await run(ctx.db, `INSERT INTO yield_findings (key, rule, source, purpose, first_seen, last_seen, metric, cost, evidence, item_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        f.key, f.rule, f.source, f.purpose, ts, ts, f.metric, f.cost, f.title, itemId);
    } else {
      await run(ctx.db, "UPDATE yield_findings SET last_seen=?, clean_runs=0, metric=?, cost=?, evidence=?, status='open' WHERE key=?", ts, f.metric, f.cost, f.title, f.key);
      if (ex.status === 'closed' && ex.item_id) await run(ctx.db, "UPDATE items SET status='open', disposition=NULL, updated_at=datetime('now') WHERE id=?", ex.item_id);
    }
  }
  for (const o of await all(ctx.db, "SELECT key, item_id, clean_runs FROM yield_findings WHERE status='open'")) {
    if (hit.has(o.key)) continue;
    const n = +o.clean_runs + 1;
    if (n >= c.clean_runs_to_close) {
      await run(ctx.db, "UPDATE yield_findings SET status='closed', clean_runs=? WHERE key=?", n, o.key);
      if (o.item_id) await run(ctx.db, "UPDATE items SET status='done', disposition='closed: rule clean for ' || ? || ' runs', updated_at=datetime('now') WHERE id=? AND status='open'", n, o.item_id);
      closed++;
    } else await run(ctx.db, 'UPDATE yield_findings SET clean_runs=? WHERE key=?', n, o.key);
  }
  const open = +(await first(ctx.db, "SELECT COUNT(*) n FROM yield_findings WHERE status='open'")).n;
  const wasted = rows.reduce((a, r) => a + (r.calls ? r.errors * r.cost / r.calls : 0), 0);
  await run(ctx.db, 'INSERT OR REPLACE INTO yield_runs (ts, wasted_cost, total_cost, outputs, cost_per_output, findings_open, items_filed, items_closed) VALUES (?,?,?,?,?,?,?,?)',
    ts, wasted, tot, outputs, outputs ? tot / outputs : null, open, filed, closed);
  return { filed, closed, findings: found.length, open };
}
