// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Topology graph and blast radius: which files, modules or services depend on a thing, so a change names what it can break.
// Ports: ctx = { db, now(), config, sources }. sources is an ORDERED LIST of edge providers ({ name, list() -> [{path, text}] }):
// no single route (a failing source is skipped and recorded; edges from other sources remain). Edges can also be declared by hand.
const IMPORT_RE = /(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|require\()\s*['"]([^'"]+)['"]|^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const nowMs = ctx => { const v = ctx.now(); return v instanceof Date ? v.getTime() : v; };
const dirname = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
export function normalize(from, spec) {
  if (!spec.startsWith('.')) return null;                 // only in-repo relative imports are edges
  const parts = (dirname(from) ? dirname(from).split('/') : []).concat(spec.split('/'));
  const out = [];
  for (const s of parts) { if (s === '.' || s === '') continue; if (s === '..') out.pop(); else out.push(s); }
  return out.join('/');
}
export function extractEdges(path, text) {
  const dst = new Set();
  for (const m of String(text).matchAll(IMPORT_RE)) { const t = normalize(path, m[1] || ''); if (t) dst.add(t); }
  return [...dst];
}
export async function ingest(ctx) {
  const ts = iso(nowMs(ctx)), report = [];
  for (const s of ctx.sources || []) {
    try {
      const files = await s.list();
      for (const f of files) {
        await ctx.db.prepare('INSERT INTO graph_nodes (id, updated_at) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at').bind(f.path, ts).run();
        await ctx.db.prepare("DELETE FROM graph_edges WHERE src = ? AND source = ?").bind(f.path, s.name).run();
        for (const d of extractEdges(f.path, f.text)) await ctx.db.prepare("INSERT OR IGNORE INTO graph_edges (src, dst, rel, source) VALUES (?,?, 'imports', ?)").bind(f.path, d, s.name).run();
      }
      report.push({ source: s.name, ok: true, files: files.length });
    } catch (e) { report.push({ source: s.name, ok: false, error: String(e?.message || e).slice(0, 200) }); }
  }
  return report;
}
export async function declare(ctx, src, dst, rel = 'calls') {
  await ctx.db.prepare("INSERT OR IGNORE INTO graph_edges (src, dst, rel, source) VALUES (?,?,?, 'declared')").bind(src, dst, rel).run();
}
/** Everything that transitively depends on any of the changed paths (breadth first, cycle safe, bounded). */
export async function blastRadius(ctx, changed, { maxNodes = 500 } = {}) {
  const seen = new Set(changed), queue = [...changed], hit = [];
  while (queue.length && hit.length < maxNodes) {
    const n = queue.shift();
    const rows = (await ctx.db.prepare('SELECT DISTINCT src FROM graph_edges WHERE dst = ? OR dst = ? OR dst = ? OR dst = ?').bind(n, n + '.js', n + '.mjs', n + '/index.js').all()).results;
    for (const r of rows) if (!seen.has(r.src)) { seen.add(r.src); hit.push(r.src); queue.push(r.src); }
  }
  return { changed, affected: hit.sort(), truncated: queue.length > 0 };
}
