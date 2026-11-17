// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The self-improving part. New evidence about a link is pooled into that link's amount by inverse-variance weighting (in log space for a
// lognormal amount), the prior is down-weighted by its grade, the model is re-scored and the change is recorded. Then the loop works out where the
// next piece of evidence is worth most: the nodes whose uncertainty drives the result and whose grade is weakest. Nothing here calls the network;
// the caller's `evidenceFor(model, target)` port finds evidence (a search, a feed, a model role) and returns items to pool.
//   evidence item = { node, estimate:{ low, high } (90% interval, same units as the node amount), grade, source, url?, at? }
import { moments } from './dist.js';
import { score } from './model.js';
import { GRADES } from './conversions.js';

const PRIOR_WEIGHT = { A: 1, B: 0.7, C: 0.4, D: 0.2 }; // a prior from weaker evidence yields sooner to new data
const GRADE_ORDER = ['D', 'C', 'B', 'A'];

export function pool(node, ev) {
  const pri = typeof node.amount === 'number' ? { mean: node.amount, sd: Math.abs(node.amount) * 0.05 + 1e-9 } : moments(node.amount);
  const shape = node.amount && node.amount.shape === 'lognormal' ? 'lognormal' : 'normal';
  const e = shape === 'lognormal' ? { mean: (Math.log(ev.estimate.low) + Math.log(ev.estimate.high)) / 2, sd: (Math.log(ev.estimate.high) - Math.log(ev.estimate.low)) / (2 * 1.6448536269514722) }
    : { mean: (ev.estimate.low + ev.estimate.high) / 2, sd: (ev.estimate.high - ev.estimate.low) / (2 * 1.6448536269514722) };
  const pw = (PRIOR_WEIGHT[node.grade] ?? 0.2) / (pri.sd ** 2 || 1e-9), ew = (PRIOR_WEIGHT[ev.grade] ?? 0.2) / (e.sd ** 2 || 1e-9);
  const mean = (pri.mean * pw + e.mean * ew) / (pw + ew), sd = Math.sqrt(1 / (pw + ew));
  const z = 1.6448536269514722;
  return shape === 'lognormal' ? { kind: 'ci90', shape, low: Math.exp(mean - z * sd), high: Math.exp(mean + z * sd) } : { kind: 'ci90', shape, low: mean - z * sd, high: mean + z * sd };
}
// Grade can only rise when evidence of a higher grade has been pooled; it never rises on its own.
const bestGrade = (a, b) => (GRADE_ORDER.indexOf(a) >= GRADE_ORDER.indexOf(b) ? a : b);

export function applyEvidence(model, items, { at = null, seed = 1 } = {}) {
  const before = score(model, { seed }), next = structuredClone(model), log = [];
  next.evidence = [...(model.evidence || [])];
  for (const ev of items) {
    const n = next.nodes.find(x => x.id === ev.node);
    if (!n || !GRADES[ev.grade] || !ev.estimate || !(ev.estimate.low <= ev.estimate.high) || !ev.source) { log.push({ node: ev.node, applied: false, why: 'malformed or unknown node' }); continue; }
    if (next.evidence.some(x => x.node === ev.node && x.source === ev.source)) { log.push({ node: ev.node, applied: false, why: 'already pooled' }); continue; }
    const was = n.amount; n.amount = pool(n, ev); n.grade = bestGrade(n.grade, ev.grade); if (n.source === 'assumption') n.source = ev.source;
    next.evidence.push({ node: ev.node, source: ev.source, url: ev.url || null, grade: ev.grade, estimate: ev.estimate, at: ev.at || at });
    log.push({ node: ev.node, applied: true, source: ev.source, from: was, to: n.amount, grade: n.grade });
  }
  const after = score(next, { seed });
  return { model: next, log, before: before.wellby_per_1000_usd, after: after.wellby_per_1000_usd, moved: after.wellby_per_1000_usd.p50 - before.wellby_per_1000_usd.p50 };
}

// Where to look next: sensitivity (how much a node drives the total) x evidence weakness (how far its grade is from A).
export function nextEvidenceTargets(model, { seed = 1, top = 3 } = {}) {
  const r = score(model, { seed }), by = new Map(model.nodes.map(n => [n.id, n]));
  return r.sensitivity.filter(s => s.kind === 'node').map(s => ({ node: s.id, label: by.get(s.id).label, grade: by.get(s.id).grade, corr: s.corr,
    value: Math.abs(s.corr) * (1 + GRADE_ORDER.indexOf('A') - GRADE_ORDER.indexOf(by.get(s.id).grade)) }))
    .sort((a, b) => b.value - a.value).slice(0, top);
}

// One pass of the loop over a tenant's models. Ports: load() -> models; save(model, result, changes); evidenceFor(model, target) -> items.
// Returns what moved, so the caller can write it to its changes feed. A pass that finds nothing still reports that it ran.
export async function refineLoop({ load, save, evidenceFor, at = null, seed = 1, perModel = 3 }) {
  const report = { at, models: 0, looked: 0, applied: 0, moved: [], queue: [] };
  for (const m of await load()) {
    report.models++;
    let cur = m, changed = false;
    const targets = nextEvidenceTargets(m, { seed, top: perModel });
    report.queue.push({ model: m.id, targets: targets.map(t => t.node) });
    for (const t of targets) {
      report.looked++;
      const items = (await evidenceFor(cur, t)) || [];
      if (!items.length) continue;
      const res = applyEvidence(cur, items, { at, seed });
      const n = res.log.filter(x => x.applied).length;
      if (n) { cur = res.model; changed = true; report.applied += n; report.moved.push({ model: m.id, node: t.node, p50_from: res.before.p50, p50_to: res.after.p50 }); }
    }
    await save(cur, score(cur, { seed }), changed);
  }
  return report;
}
