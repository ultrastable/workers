// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Wiring graph (US-SPEC-12 Part B): sweep deployment metadata, analyze islands, sinks, sources, unresolved targets and
// drift, join each table's writers with its readers, derive data-flow edges, and keep a census that separates idle from unmeasured.
// Ports only: ctx = { db, now(), config, metadata: { account?, list() -> [name], describe(name) -> {...} },
//                     registry?: { list() -> [{name, version?, status?}] }, roster?: { list() -> [name] },
//                     activity?: { read(names) -> { name: {runs, failures, last_active_at, requests: {kind: n}} } } }.
// The sweep reads the metadata port only: nothing here reads documentation or a hand-written list of bindings (US-12-R09).

export const BINDING_TYPES = ['database', 'kv', 'bucket', 'vector', 'queue', 'durable_object', 'workflow', 'service', 'ai', 'secret', 'variable'];
const DEFAULTS = { account: null, retire_after_days: 2, non_external_kinds: ['probe', 'calibration', 'synthetic'], owner_role: 'operations' };
export const cfg = ctx => ({ ...DEFAULTS, ...(ctx.config || {}) });
const nowMs = ctx => { const v = ctx.now(); return v instanceof Date ? v.getTime() : v; };
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const parseIso = s => Date.parse(String(s).replace(' ', 'T') + 'Z');
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
const strs = v => (Array.isArray(v) ? v.map(String) : []);

// ---- table access read from source text --------------------------------------------------------

const WRITE_RE = /\b(?:insert\s+(?:or\s+\w+\s+)?into|replace\s+into|update|delete\s+from)\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)/gi;
const READ_RE = /\b(?:from|join)\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)/gi;
const NOT_TABLES = new Set(['select', 'set', 'values', 'where', 'the', 'a', 'an', 'this', 'that', 'it', 'sqlite_master', 'json_each']);
/** Tables a script writes and reads, from the SQL in its text. `DELETE FROM t` is a write, not a read. */
export function extractTableAccess(text) {
  const src = String(text || '');
  const writes = new Set(), reads = new Set();
  for (const m of src.matchAll(WRITE_RE)) if (!NOT_TABLES.has(m[1].toLowerCase())) writes.add(m[1]);
  // module syntax (`import x from './y.js'`, `export * from`) and `DELETE FROM t` are not reads
  const sql = src.replace(/\b(?:import|export)\b[^;\n]*?\bfrom\s*['"][^'"]*['"]/g, ' ').replace(/\bdelete\s+from\b/gi, ' ');
  for (const m of sql.matchAll(READ_RE)) if (!NOT_TABLES.has(m[1].toLowerCase())) reads.add(m[1]);
  return { writes: [...writes].sort(), reads: [...reads].sort() };
}

// ---- sweep (US-12-R09, R10) --------------------------------------------------------------------

function cleanWorker(name, d) {
  const bindings = [];
  for (const b of Array.isArray(d.bindings) ? d.bindings : []) {
    if (!b || !BINDING_TYPES.includes(b.type)) continue;
    // a secret or a text variable is recorded by name only: no value ever enters the graph store
    if (b.type === 'secret' || b.type === 'variable') bindings.push({ type: b.type, name: String(b.name) });
    else bindings.push({ type: b.type, name: String(b.name), target: b.target == null ? null : String(b.target) });
  }
  const tables = { writes: new Set(strs(d.tables && d.tables.writes)), reads: new Set(strs(d.tables && d.tables.reads)) };
  if (typeof d.source === 'string') { const x = extractTableAccess(d.source); x.writes.forEach(t => tables.writes.add(t)); x.reads.forEach(t => tables.reads.add(t)); }
  return { name, version: d.version ? String(d.version) : null, crons: strs(d.crons), routes: strs(d.routes), queue_consumers: strs(d.queue_consumers), bindings,
    tables: { writes: [...tables.writes].sort(), reads: [...tables.reads].sort() } };
}

/** Read every worker's metadata. A worker whose read errored is listed under `errors` and excluded from the counts. */
export async function sweep(ctx) {
  if (!ctx.metadata || typeof ctx.metadata.list !== 'function' || typeof ctx.metadata.describe !== 'function') throw new Error('the sweep needs the deployment metadata port');
  const generated = iso(nowMs(ctx)), workers = [], errors = [];
  for (const name of [...new Set(await ctx.metadata.list())].sort()) {
    try { workers.push(cleanWorker(name, (await ctx.metadata.describe(name)) || {})); }
    catch (e) { errors.push({ worker: name, error: String((e && e.message) || e).slice(0, 200) }); }
  }
  const ins = await run(ctx.db, `INSERT INTO graph_wiring_sweeps (generated, account, worker_count, errors, workers) VALUES (?,?,?,?,?)`,
    generated, ctx.metadata.account ?? cfg(ctx).account, workers.length, JSON.stringify(errors), JSON.stringify(workers));
  const sweepId = ins.meta.last_row_id;
  for (const w of workers) {
    const put = (resource, mode) => run(ctx.db, `INSERT OR IGNORE INTO graph_wiring_access (sweep_id, resource, worker, mode) VALUES (?,?,?,?)`, sweepId, resource, w.name, mode);
    for (const t of w.tables.writes) await put(`table:${t}`, 'write');
    for (const t of w.tables.reads) await put(`table:${t}`, 'read');
    for (const b of w.bindings) if (b.type === 'queue') await put(`queue:${b.target || b.name}`, 'write');
    for (const q of w.queue_consumers) await put(`queue:${q}`, 'read');
  }
  return { sweep_id: sweepId, generated, account: ctx.metadata.account ?? cfg(ctx).account, worker_count: workers.length, errors, workers };
}

// ---- analyzer (US-12-R11, R12) -----------------------------------------------------------------

/** Pure graph analysis: nodes are worker names, edges are distinct (caller, callee) pairs. */
export function analyzeGraph(nodes, edges, registryNames = []) {
  const n = new Set(nodes), reg = new Set(registryNames);
  const seen = new Set(), inDeg = new Map(), outDeg = new Map(), unresolved = new Set();
  let count = 0;
  for (const [a, b] of edges) {
    const k = `${a}\u0000${b}`;
    if (a === b || seen.has(k) || !n.has(a)) continue;
    seen.add(k);
    if (!n.has(b)) { if (!reg.has(b)) { unresolved.add(b); continue; } } else inDeg.set(b, (inDeg.get(b) || 0) + 1);
    outDeg.set(a, (outDeg.get(a) || 0) + 1); count++;
  }
  const islands = [], sinks = [], sources = [];
  for (const w of [...n].sort()) {
    const i = inDeg.get(w) || 0, o = outDeg.get(w) || 0;
    if (!i && !o) islands.push(w); else if (i && !o) sinks.push(w); else if (o && !i) sources.push(w);
  }
  const density = n.size > 1 ? count / (n.size * (n.size - 1)) : 0;
  return { nodes: n.size, edges: count, density, islands, sinks, sources, unresolved: [...unresolved].sort() };
}

/** Writers joined with readers per resource: orphans, and one data-flow edge from each writer to each other reader. */
export function producerConsumer(access) {
  const by = new Map();
  for (const a of access) { const r = by.get(a.resource) || { writers: new Set(), readers: new Set() }; r[a.mode === 'write' ? 'writers' : 'readers'].add(a.worker); by.set(a.resource, r); }
  const map = [], orphans = [], flows = [];
  for (const [resource, r] of [...by.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const writers = [...r.writers].sort(), readers = [...r.readers].sort();
    map.push({ resource, writers, readers });
    if (writers.length && !readers.length) orphans.push({ resource, fault: 'producer_without_consumer', writers });
    if (readers.length && !writers.length) orphans.push({ resource, fault: 'consumer_without_producer', readers });
    for (const w of writers) for (const rd of readers) if (w !== rd) flows.push({ from: w, to: rd, via: resource });
  }
  return { map, orphans, flows };
}

/**
 * Analyze a sweep (the newest by default) against the registry: labels, drift counts, orphan tables, data-flow edges and
 * an integration score (the share of swept workers with at least one service or data-flow edge). Service and data-flow
 * edges are also written to graph_edges as `worker:<name>` nodes so blast radius can follow them.
 */
export async function analyze(ctx, { sweep_id = null } = {}) {
  const sw = sweep_id ? await first(ctx.db, `SELECT * FROM graph_wiring_sweeps WHERE id = ?`, sweep_id) : await first(ctx.db, `SELECT * FROM graph_wiring_sweeps ORDER BY id DESC LIMIT 1`);
  if (!sw) throw new Error('no sweep to analyze');
  const workers = JSON.parse(sw.workers), errored = JSON.parse(sw.errors).map(e => e.worker);
  const names = workers.map(w => w.name);
  const registry = ctx.registry && typeof ctx.registry.list === 'function' ? await ctx.registry.list() : [];
  const regActive = registry.filter(r => r.status !== 'retired').map(r => r.name), regAll = registry.map(r => r.name);
  const edges = workers.flatMap(w => w.bindings.filter(b => b.type === 'service' && b.target).map(b => [w.name, b.target]));
  const g = analyzeGraph(names, edges, regAll);
  const swept = new Set(names), excluded = new Set(errored), known = new Set(regAll);
  const ghosts = regActive.filter(n => !swept.has(n) && !excluded.has(n)).sort();   // an errored read is unknown, not a ghost
  const unregistered = names.filter(n => !known.has(n)).sort();
  const unversioned = workers.filter(w => !w.version).map(w => w.name).sort();
  const pc = producerConsumer(await all(ctx.db, `SELECT resource, worker, mode FROM graph_wiring_access WHERE sweep_id = ?`, sw.id));
  const flowPairs = [...new Set(pc.flows.map(f => `${f.from}\u0000${f.to}`))].map(k => k.split('\u0000'));
  const touched = new Set(flowPairs.flat());
  const islandsWithFlow = g.islands.filter(w => !touched.has(w));
  const score = g.nodes ? (g.nodes - islandsWithFlow.length) / g.nodes : 0;
  const at = iso(nowMs(ctx));
  await run(ctx.db, `DELETE FROM graph_edges WHERE source = 'wiring'`);
  for (const w of names) await run(ctx.db, `INSERT INTO graph_nodes (id, kind, updated_at) VALUES (?, 'worker', ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`, `worker:${w}`, at);
  for (const [a, b] of edges) if (a !== b) await run(ctx.db, `INSERT OR IGNORE INTO graph_edges (src, dst, rel, source) VALUES (?,?, 'service', 'wiring')`, `worker:${a}`, `worker:${b}`);
  for (const [from, to] of flowPairs) await run(ctx.db, `INSERT OR IGNORE INTO graph_edges (src, dst, rel, source) VALUES (?,?, 'data_flow', 'wiring')`, `worker:${to}`, `worker:${from}`); // the reader depends on the writer
  const detail = { islands: g.islands, sinks: g.sinks, sources: g.sources, unresolved: g.unresolved, ghosts, unregistered, unversioned, errors: errored,
    orphan_tables: pc.orphans, data_flow: pc.flows, islands_with_data_flow: islandsWithFlow };
  const ins = await run(ctx.db, `INSERT INTO graph_wiring_analyses (sweep_id, at, nodes, edges, density, islands, sinks, sources, unresolved, ghosts, unregistered, unversioned,
      data_flow_edges, islands_with_data_flow, orphan_tables, integration_score, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    sw.id, at, g.nodes, g.edges, g.density, g.islands.length, g.sinks.length, g.sources.length, g.unresolved.length, ghosts.length, unregistered.length, unversioned.length,
    flowPairs.length, islandsWithFlow.length, pc.orphans.length, score, JSON.stringify(detail));
  for (const o of pc.orphans.filter(x => x.fault === 'producer_without_consumer'))
    await run(ctx.db, `INSERT OR IGNORE INTO items (id,title,kind,owner_role,done_check,closing_probe,priority,status) VALUES (?,?,'fix',?,?,?,40,'open')`,
      `WIRING-ORPHAN-${o.resource.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60)}`, `${o.resource} is written by ${o.writers.join(', ')} and read by nothing`, cfg(ctx).owner_role,
      `${o.resource} has a reader, or its writer is removed`, `wiring analysis lists no producer_without_consumer fault for ${o.resource}`);
  return { analysis_id: ins.meta.last_row_id, sweep_id: sw.id, generated: sw.generated, nodes: g.nodes, edges: g.edges, density: g.density, integration_score: score,
    data_flow_edges: flowPairs.length, map: pc.map, ...detail };
}

// ---- census (US-12-R13, R14) -------------------------------------------------------------------

/** Requests that count as external usage: every kind except probe, calibration and other configured non-external kinds. */
export function externalUsage(requests, nonExternal = DEFAULTS.non_external_kinds) {
  let external = 0, excluded = 0;
  for (const [kind, n] of Object.entries(requests || {})) (nonExternal.includes(kind) ? (excluded += Number(n) || 0) : (external += Number(n) || 0));
  return { external, excluded };
}

/**
 * One row per member with measured activity. A member missing from the monitor roster, or with no reading, is `unmeasured`
 * and its action is `extend_roster`: it is never a retirement candidate. A measured member is a candidate only when it has
 * been dead for retire_after_days or when it fires and every run fails.
 */
export async function census(ctx, { members = null } = {}) {
  const c = cfg(ctx), now = nowMs(ctx), at = iso(now);
  let names = members;
  if (!names) {
    const sw = await first(ctx.db, `SELECT workers FROM graph_wiring_sweeps ORDER BY id DESC LIMIT 1`);
    const reg = ctx.registry ? (await ctx.registry.list()).filter(r => r.status !== 'retired').map(r => r.name) : [];
    names = [...new Set([...(sw ? JSON.parse(sw.workers).map(w => w.name) : []), ...reg])];
  }
  names = [...names].sort();
  const roster = new Set(ctx.roster ? await ctx.roster.list() : []);
  const readings = ctx.activity ? (await ctx.activity.read(names.filter(n => roster.has(n)))) || {} : {};
  const rows = [];
  for (const name of names) {
    const prior = await first(ctx.db, `SELECT * FROM graph_wiring_census WHERE name = ?`, name);
    const r = roster.has(name) ? readings[name] : null;
    let row;
    if (!r) row = { name, in_roster: roster.has(name) ? 1 : 0, first_measured_at: prior ? prior.first_measured_at : null, last_active_at: prior ? prior.last_active_at : null,
      runs: null, failures: null, external_requests: null, excluded_requests: null, class: 'unmeasured', action: 'extend_roster' };
    else {
      const runs = Number(r.runs) || 0, failures = Number(r.failures) || 0, use = externalUsage(r.requests, c.non_external_kinds);
      const activeNow = runs > failures || use.external > 0;
      const firstMeasured = (prior && prior.first_measured_at) || at;
      const lastActive = activeNow ? (r.last_active_at || at) : (r.last_active_at || (prior && prior.last_active_at) || null);
      const deadDays = (now - parseIso(lastActive || firstMeasured)) / 86400000;
      let cls, action;
      if (runs > 0 && failures >= runs && use.external === 0) { cls = 'failing'; action = 'retire_candidate'; }
      else if (activeNow) { cls = 'active'; action = 'keep'; }
      else { cls = 'idle'; action = deadDays >= c.retire_after_days ? 'retire_candidate' : 'watch'; }
      row = { name, in_roster: 1, first_measured_at: firstMeasured, last_active_at: lastActive, runs, failures, external_requests: use.external, excluded_requests: use.excluded, class: cls, action };
    }
    await run(ctx.db, `INSERT INTO graph_wiring_census (name, in_roster, first_measured_at, last_active_at, runs, failures, external_requests, excluded_requests, class, action, checked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET in_roster=excluded.in_roster, first_measured_at=excluded.first_measured_at, last_active_at=excluded.last_active_at, runs=excluded.runs, failures=excluded.failures,
        external_requests=excluded.external_requests, excluded_requests=excluded.excluded_requests, class=excluded.class, action=excluded.action, checked_at=excluded.checked_at`,
      row.name, row.in_roster, row.first_measured_at, row.last_active_at, row.runs, row.failures, row.external_requests, row.excluded_requests, row.class, row.action, at);
    rows.push(row);
  }
  const count = k => rows.filter(r => r.class === k).length;
  return { at, members: rows, counts: { active: count('active'), idle: count('idle'), failing: count('failing'), unmeasured: count('unmeasured') },
    retire_candidates: rows.filter(r => r.action === 'retire_candidate').map(r => r.name), extend_roster: rows.filter(r => r.action === 'extend_roster').map(r => r.name) };
}

/** One tick: sweep, analyze, census. Returns the dated counts. */
export async function step(ctx) {
  if (cfg(ctx).enabled === false || !ctx.metadata) return { enabled: false };
  const s = await sweep(ctx), a = await analyze(ctx, { sweep_id: s.sweep_id }), c = await census(ctx);
  return { generated: s.generated, worker_count: s.worker_count, errors: s.errors.length, edges: a.edges, density: a.density, islands: a.islands.length, sinks: a.sinks.length,
    sources: a.sources.length, unresolved: a.unresolved.length, ghosts: a.ghosts.length, unregistered: a.unregistered.length, unversioned: a.unversioned.length,
    orphan_tables: a.orphan_tables.length, integration_score: a.integration_score, census: c.counts };
}
