// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The read-only public metrics view served from the Worker (issue #13, docs/SELF-HOSTING.md section 1). Same five measures and
// the same JSON keys as tools/public_metrics.py; each is computed from the organization's own tables or reported as null with
// the reason. Aggregates only: no item titles, no tokens, no names. Off unless config.public_metrics.enabled === true.
//  GET /public/metrics.json   GET /public/metrics   (GET only; static, escaped, script-free HTML with a locked-down CSP)
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const one = (db, sql, ...a) => db.prepare(sql).bind(...a).first();

export async function computeMetrics({ db, now, config = {}, routerCaps = [] }) {
  const pm = config.public_metrics || {};
  const notMeasured = {};
  // 1. remaining capabilities: pushed into org.spec_remaining (JSON from tools/spec_backlog.py --summary) or the config
  let remaining = pm.remaining || null;
  if (!remaining) {
    const row = await one(db, `SELECT value FROM org WHERE key = 'spec_remaining'`);
    try { remaining = row ? JSON.parse(row.value) : null; } catch { remaining = null; }
  }
  if (!remaining) notMeasured.remaining_capabilities = 'not measured: store tools/spec_backlog.py --summary output under org key spec_remaining';
  // 2. agent pull requests, from the runner's own runs. The runner never merges, so merged is null unless supplied.
  const runs = await db.prepare(`SELECT state, COUNT(*) AS n FROM runner_runs GROUP BY state`).all().then(r => r.results || []).catch(() => []);
  const by = Object.fromEntries(runs.map(r => [r.state, Number(r.n)]));
  const opened = by.pr_opened || 0, rejected = by.refused || 0, active = Object.entries(by).filter(([k]) => !['pr_opened', 'refused'].includes(k)).reduce((a, [, n]) => a + n, 0);
  const mergedRow = await one(db, `SELECT value FROM org WHERE key = 'agent_prs_merged'`);
  const merged = mergedRow ? Number(mergedRow.value) : null;
  // 3. predictions the system scored about its own work
  const p = await one(db, `SELECT COUNT(*) AS made, COALESCE(SUM(CASE WHEN verdict = 'hit' THEN 1 ELSE 0 END), 0) AS right FROM predictions WHERE verdict IS NOT NULL`);
  const predictions = Number(p.made) ? { made: Number(p.made), right: Number(p.right), hit_rate: Math.round((Number(p.right) / Number(p.made)) * 1000) / 1000 } : null;
  if (!predictions) notMeasured.predictions = 'not measured: no prediction has been scored yet';
  // 4. money: model spend this month against the total monthly hard cap
  const d = new Date(now);
  const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().replace('T', ' ').slice(0, 19);
  const s = await one(db, `SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS usd FROM router_calls WHERE at >= ?`, monthStart);
  const cap = (routerCaps.find(c => c.scope === 'total' && c.period === 'month') || {}).hard_usd ?? null;
  const spend = Math.round(Number(s.usd) * 1e4) / 1e4;
  const money = { spend_usd: spend, cap_usd: cap, within_cap: cap === null ? null : spend <= cap, cost_per_merged_pr_usd: merged ? Math.round((spend / merged) * 1e4) / 1e4 : null };
  // 5. autonomy: surfaces by the rung they hold now
  const rungs = await db.prepare(`SELECT rung, COUNT(*) AS n FROM trust_ledger GROUP BY rung`).all().then(r => r.results || []);
  const autonomy = rungs.length ? { surfaces: rungs.reduce((a, r) => a + Number(r.n), 0), by_rung: Object.fromEntries(rungs.map(r => [r.rung, Number(r.n)])) } : null;
  if (!autonomy) notMeasured.autonomy = 'not measured: the trust ledger is empty';
  return {
    generated_at: new Date(now).toISOString(), remaining_capabilities: remaining,
    agent_prs: { opened, merged, rejected, open: active }, predictions, money, autonomy, not_measured: notMeasured,
  };
}

export function renderHtml(m) {
  const rows = [];
  const row = (k, v) => rows.push(`<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`);
  const rc = m.remaining_capabilities;
  row('Remaining capabilities', rc ? rc.remaining : m.not_measured.remaining_capabilities);
  const a = m.agent_prs;
  row('Agent pull requests', `${a.opened} opened, ${a.merged ?? 'merged not measured'} merged, ${a.rejected} refused, ${a.open} in progress`);
  const p = m.predictions;
  row('Predictions right', p ? `${p.right} of ${p.made}` : m.not_measured.predictions);
  const mo = m.money;
  row('Spend this month', `$${mo.spend_usd} (cap ${mo.cap_usd ?? 'not set'}), per merged PR ${mo.cost_per_merged_pr_usd ?? 'not measured'}`);
  const au = m.autonomy;
  row('Autonomy', au ? `${au.surfaces} surfaces, by rung ${JSON.stringify(au.by_rung)}` : m.not_measured.autonomy);
  return '<!doctype html><meta charset=utf-8><title>Ultrastable improving Ultrastable</title>'
    + "<meta http-equiv=Content-Security-Policy content=\"default-src 'none'; style-src 'unsafe-inline'\">"
    + '<style>body{font:16px system-ui;margin:2rem auto;max-width:42rem}th{text-align:left;padding-right:1rem}</style>'
    + `<h1>Ultrastable improving Ultrastable</h1><table>${rows.join('')}</table><p>Generated ${esc(m.generated_at)}</p>`;
}

/** Returns a Response for the two public paths, or null for any other path. GET only. */
export async function handlePublicMetrics(request, { db, now, config }) {
  const p = new URL(request.url).pathname.replace(/\/+$/, '');
  if (p !== '/public/metrics' && p !== '/public/metrics.json') return null;
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers: { allow: 'GET' } });
  const m = await computeMetrics({ db, now, config, routerCaps: config.router?.caps || [] });
  const headers = { 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' };
  return p.endsWith('.json')
    ? Response.json(m, { headers })
    : new Response(renderHtml(m), { headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } });
}
