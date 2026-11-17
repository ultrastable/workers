// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Knowledge graph that drives knowledge generation, not only storage. Tenant-agnostic: node kinds, relations and gap rules are the tenant's data.
// A node is { id, kind, label, props, provenance[] }; an edge is { src, rel, dst, why, provenance[] }. Every fact carries provenance
// ({ source, url, at }) so a reader can trace it. The graph lives in a store port ({ get(k), put(k, v) }; a KV namespace fits).
// Generation: `gaps(rules)` finds nodes that lack an expected relation; `questions(rules)` turns each gap into a question a loop can work on;
// `propose(...)` records an unconfirmed edge that only `confirm` promotes. Nothing here calls a model or the network.
const KEY = 'kgraph:v1';
const ek = e => `${e.src}|${e.rel}|${e.dst}`;
const prov = p => (Array.isArray(p) ? p : p ? [p] : []).map(x => ({ source: String(x.source || ''), url: x.url || null, at: x.at || null }));

export function createGraph({ store, key = KEY } = {}) {
  let g = null;
  const load = async () => (g ||= JSON.parse((await store.get(key)) || '{"nodes":{},"edges":{}}'));
  const save = () => store.put(key, JSON.stringify(g));

  return {
    async addNode({ id, kind, label, props = {}, provenance }) {
      if (!id || !kind) throw new Error('node needs id and kind');
      await load();
      const o = g.nodes[id];
      g.nodes[id] = { id, kind, label: label ?? (o && o.label) ?? id, props: { ...(o ? o.props : {}), ...props }, provenance: [...(o ? o.provenance : []), ...prov(provenance)] };
      await save(); return g.nodes[id];
    },
    // status 'confirmed' (default) or 'proposed': a proposed edge is a lead and never counts toward a gap being filled
    async addEdge({ src, rel, dst, why = '', provenance, status = 'confirmed' }) {
      await load();
      if (!g.nodes[src] || !g.nodes[dst]) throw new Error(`edge ${src} -${rel}-> ${dst} has a missing end`);
      const e = { src, rel, dst, why, status, provenance: prov(provenance) };
      const o = g.edges[ek(e)];
      g.edges[ek(e)] = o ? { ...o, why: why || o.why, provenance: [...o.provenance, ...e.provenance], status: o.status === 'confirmed' ? 'confirmed' : status } : e;
      await save(); return g.edges[ek(e)];
    },
    propose(e) { return this.addEdge({ ...e, status: 'proposed' }); },
    async confirm({ src, rel, dst, provenance }) {
      await load(); const e = g.edges[ek({ src, rel, dst })];
      if (!e) throw new Error('no such edge');
      if (!prov(provenance).length) throw new Error('confirming needs provenance');
      e.status = 'confirmed'; e.provenance.push(...prov(provenance)); await save(); return e;
    },
    async node(id) { await load(); return g.nodes[id] || null; },
    async nodes({ kind } = {}) { await load(); return Object.values(g.nodes).filter(n => !kind || n.kind === kind); },
    async edges({ rel, status = 'confirmed' } = {}) { await load(); return Object.values(g.edges).filter(e => (!rel || e.rel === rel) && (status === 'any' || e.status === status)); },
    // out: edges from id; in: edges to id (backlinks, "what links here")
    async neighbors(id, { rel, dir = 'out', status = 'confirmed' } = {}) {
      return (await this.edges({ rel, status })).filter(e => (dir === 'out' ? e.src === id : e.dst === id)).map(e => ({ rel: e.rel, why: e.why, node: g.nodes[dir === 'out' ? e.dst : e.src] }));
    },
    // breadth-first reach from a node over chosen relations; bounded and cycle safe
    async reach(id, { rels, depth = 3, limit = 200 } = {}) {
      await load(); const seen = new Map([[id, 0]]); let frontier = [id];
      for (let d = 1; d <= depth && frontier.length && seen.size < limit; d++) {
        const next = [];
        for (const e of Object.values(g.edges)) if (e.status === 'confirmed' && frontier.includes(e.src) && (!rels || rels.includes(e.rel)) && !seen.has(e.dst) && seen.size < limit) { seen.set(e.dst, d); next.push(e.dst); }
        frontier = next;
      }
      return [...seen].filter(([n]) => n !== id).map(([n, d]) => ({ node: g.nodes[n], distance: d }));
    },
    // rule: { kind, lacks: { rel, dir?, to? }, ask: (node) => string, id }. A gap is a node of `kind` with no confirmed edge matching `lacks`.
    async gaps(rules) {
      await load(); const out = [];
      for (const r of rules) for (const n of Object.values(g.nodes)) {
        if (n.kind !== r.kind) continue;
        const l = r.lacks, has = Object.values(g.edges).some(e => e.status === 'confirmed' && e.rel === l.rel && ((l.dir || 'out') === 'out' ? e.src === n.id : e.dst === n.id)
          && (!l.to || g.nodes[(l.dir || 'out') === 'out' ? e.dst : e.src]?.kind === l.to));
        if (!has) out.push({ rule: r.id, node: n.id, kind: n.kind, lacks: l.rel });
      }
      return out;
    },
    // the questions a loop should work on next, in a stable order; `ask` is the tenant's wording
    async questions(rules) {
      const by = Object.fromEntries(rules.map(r => [r.id, r]));
      return (await this.gaps(rules)).map(x => ({ id: `${x.rule}:${x.node}`, subject: x.node, rule: x.rule, text: by[x.rule].ask(g.nodes[x.node]) })).sort((a, b) => a.id.localeCompare(b.id));
    },
    // structural health: dangling edges and facts with no provenance
    async validate() {
      await load(); const problems = [];
      for (const e of Object.values(g.edges)) { if (!g.nodes[e.src] || !g.nodes[e.dst]) problems.push({ kind: 'dangling', edge: ek(e) }); if (e.status === 'confirmed' && !e.provenance.length) problems.push({ kind: 'no_provenance', edge: ek(e) }); }
      return problems;
    },
    async stats() { await load(); const k = {}; for (const n of Object.values(g.nodes)) k[n.kind] = (k[n.kind] || 0) + 1; const r = {}; for (const e of Object.values(g.edges)) r[e.rel + ':' + e.status] = (r[e.rel + ':' + e.status] || 0) + 1; return { nodes: k, edges: r }; },
    async export() { await load(); return { nodes: Object.values(g.nodes), edges: Object.values(g.edges) }; },
    async import({ nodes = [], edges = [] }) { for (const n of nodes) await this.addNode(n); for (const e of edges) await this.addEdge(e); return this.stats(); },
  };
}
