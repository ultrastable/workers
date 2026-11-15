// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Product dashboard (US-SPEC-13 section 3): `/` status page, `/api/state`, `/api/refresh`, `/api/integration`, `/api/loop`,
// `/health`. The page, the JSON and the digest are rendered from one state object (US-13-R02). The page loads nothing from
// another host and every dynamic value is escaped. Probe targets are checked against routing before a worker is called down
// (US-13-R13). Ports: db, l3 (createConsoleL3), sla (createSla, optional), now. Auth is the caller's job.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** US-13-R13. probes: [{ id, url }]; routes: hostnames or host/path prefixes that are actually routed; results: { id: { ok, status } }.
 *  A probe whose target is not routed is reported `unrouted`, never `down`: the worker may be live with no route. */
export function classifyProbes(probes = [], routes = [], results = {}) {
  const routed = target => {
    let u; try { u = new URL(target); } catch { return false; }
    return routes.some(r => { const [host, ...rest] = String(r).replace(/^https?:\/\//, '').split('/'); const prefix = '/' + rest.join('/'); return u.hostname === host && u.pathname.startsWith(prefix === '/' ? '/' : prefix.replace(/\*$/, '')); });
  };
  return probes.map(p => {
    const res = results[p.id];
    const state = !routed(p.url) ? 'unrouted' : !res ? 'unknown' : res.ok ? 'up' : 'down';
    return { id: p.id, url: p.url, state, status: res?.status ?? null };
  });
}

export function createDashboard({ db, l3, sla = null, now = () => Date.now(), config = {} } = {}) {
  const clock = typeof now === 'function' ? now : () => now;
  const all = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
  const one = (sql, ...a) => db.prepare(sql).bind(...a).first();
  const has = async table => !!(await one(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table).catch(() => null));

  /** Last execute time and what the last check did with the work it scanned. */
  async function loop() {
    const tick = await one(`SELECT id, started_at, finished_at, steps_completed, steps_total FROM tick_runs ORDER BY id DESC LIMIT 1`);
    if (!tick) return { last_execute_at: null, scanned: 0, executed: 0, failed: 0, needs_human: 0, no_action: 0 };
    const d = Object.fromEntries((await all(`SELECT status, COUNT(*) AS n FROM dispatches WHERE tick_id=? GROUP BY status`, tick.id)).map(r => [r.status, r.n]));
    const scanned = (await one(`SELECT COUNT(*) AS n FROM items WHERE status NOT IN ('done','superseded','cancelled')`)).n;
    const executed = (d.done || 0) + (d.running || 0) + (d.queued || 0);
    const failed = d.failed || 0;
    const needs_human = (await one(`SELECT COUNT(*) AS n FROM gate_cards WHERE status='open'`)).n;
    return { last_execute_at: tick.finished_at || tick.started_at, tick_id: tick.id, finished: tick.steps_completed === tick.steps_total, scanned, executed, failed, needs_human, no_action: Math.max(0, scanned - executed - failed) };
  }

  /** The wiring graph in numbers: registered nodes, live nodes (touched by an edge), edges, islands (no edge), sinks (inbound
   *  only), density, and drift (edges naming a node that is not registered). Empty when no graph is stored. */
  async function integration() {
    if (!(await has('graph_nodes')) || !(await has('graph_edges'))) return { available: false, registered: 0, live: 0, edges: 0, islands: [], sinks: [], density: 0, drift: [] };
    const nodes = (await all(`SELECT id FROM graph_nodes ORDER BY id`)).map(r => r.id);
    const edges = await all(`SELECT src, dst FROM graph_edges`);
    const reg = new Set(nodes); const out = new Set(edges.map(e => e.src)); const inn = new Set(edges.map(e => e.dst));
    const islands = nodes.filter(n => !out.has(n) && !inn.has(n));
    const sinks = nodes.filter(n => inn.has(n) && !out.has(n));
    const drift = [...new Set(edges.flatMap(e => [e.src, e.dst]).filter(n => !reg.has(n)))].sort();
    const n = nodes.length;
    return { available: true, registered: n, live: n - islands.length, edges: edges.length, islands, sinks, density: n > 1 ? Math.round((edges.length / (n * (n - 1))) * 1e4) / 1e4 : 0, drift };
  }

  /** The one state every surface below is rendered from. */
  async function state() {
    const base = await l3.state();
    const card = await l3.reportCard(config.card_name || 'autonomy');
    return { ...base, loop: await loop(), integration: await integration(), service_levels: sla ? await sla.summary() : null,
      report_card: card ? { name: card.name, at: card.at, overall: card.overall, limits: card.limits, scores: card.scores } : null };
  }

  function render(s) {
    const li = xs => xs.map(x => `<li>${x}</li>`).join('');
    const sl = s.service_levels;
    const head = !s.last_tick ? 'Starting up. The first check has not run yet.' : !s.last_tick.ok ? 'The last check did not finish.' : s.waiting_on_a_person ? `Running. ${esc(s.waiting_on_a_person)} waiting on a person.` : 'Running. Nothing is waiting on a person.';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Status</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem}h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:1.6rem}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.3rem .5rem;border-bottom:1px solid #8884}small{opacity:.75}</style></head><body>
<h1>${esc(head)}</h1><p><small>Version ${esc(s.version)}, read ${esc(s.at)}</small></p>
<h2>Work</h2><ul>${li([`${esc(s.items.open)} open`, `${esc(s.items.claimed)} in progress`, `${esc(s.items.blocked)} blocked`, `${esc(s.items.done)} done`])}</ul>
<h2>Last check</h2><ul>${li([`ran at ${esc(s.loop.last_execute_at ?? 'never')}`, `${esc(s.loop.scanned)} scanned, ${esc(s.loop.executed)} acted on, ${esc(s.loop.failed)} failed, ${esc(s.loop.needs_human)} need a person, ${esc(s.loop.no_action)} no action`])}</ul>
<h2>Decisions waiting</h2>${s.gate_cards.list.length ? `<ul>${li(s.gate_cards.list.map(c => `${esc(c.what)} <small>(if nothing is done: ${esc(c.default_in_effect)})</small>`))}</ul>` : '<p>None.</p>'}
${sl ? `<h2>Due dates</h2><table><tr><th>Severity</th><th>Open</th><th>Past due</th></tr>${sl.by_severity.map(r => `<tr><td>${esc(r.severity)}</td><td>${esc(r.n)}</td><td>${esc(r.past_due || 0)}</td></tr>`).join('')}</table>` : ''}
<h2>Wiring</h2><p>${s.integration.available ? `${esc(s.integration.registered)} registered, ${esc(s.integration.live)} connected, ${esc(s.integration.islands.length)} unconnected, ${esc(s.integration.drift.length)} named but not registered.` : 'No wiring graph is stored yet.'}</p>
${s.report_card ? `<h2>Report card: ${esc(s.report_card.overall?.toFixed(2))} of 5</h2><p><small>${esc(s.report_card.limits)}</small></p><table><tr><th>Dimension</th><th>Score</th><th>Evidence</th><th>Confidence</th></tr>${s.report_card.scores.map(r => `<tr><td>${esc(r.dimension)}</td><td>${esc(r.score)}</td><td>${esc(r.evidence)}</td><td>${esc(r.confidence)}</td></tr>`).join('')}</table>` : ''}
<p><small>Predictions called right: ${esc(s.predictions.hit)} of ${esc(s.predictions.scored)}. The same numbers are at /api/state.</small></p></body></html>`;
  }

  /** Routes. `prefix` lets the host mount it (for example '/dashboard'). Returns null for a path that is not ours.
   *  GET only, except POST /api/refresh which recomputes the service levels and returns the fresh state. */
  async function handle(request, { prefix = '' } = {}) {
    const url = new URL(request.url);
    if (prefix && !(url.pathname === prefix || url.pathname.startsWith(prefix + '/'))) return null;
    const p = url.pathname.slice(prefix.length) || '/';
    if (request.method === 'POST' && p === '/api/refresh') {
      const refreshed = sla ? await sla.recompute() : null;
      return json({ refreshed, state: await state() });
    }
    if (request.method !== 'GET') return null;
    if (p === '/') return new Response(render(await state()), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' } });
    if (p === '/api/state') return json(await state());
    if (p === '/api/integration') return json(await integration());
    if (p === '/api/loop') return json(await loop());
    if (p === '/health') { const h = await l3.health(); return json(h, h.ok ? 200 : 503); }
    return null;
  }

  return { state, loop, integration, render, handle, at: () => clock() };
}
