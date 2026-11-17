// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// A benefit-cost model is a causal chain. Each outcome node is graded for evidence and may hang off a parent (second and third order effects,
// multipliers) or be negative (unintended consequences). A child inherits its parent's credibility haircut, so a long chain of weak links is
// automatically worth less than a short chain of strong ones. Everything is propagated by Monte Carlo; nothing is a point estimate.
//   model = { id, title, cost:{ upfront, annual, years }, nodes:[{ id, label, kind:'direct'|'spillover'|'multiplier'|'unintended', parent?, order?, amount, unit,
//             years?, lag?, decay?, grade:'A'..'D', source, sign? }], params?:{ id: dist }, benchmark?:{ id, label, wellby_per_1000: dist } }
import { rng, sample, validDist, summarize } from './dist.js';
import { PARAMS, GRADES, UNITS, streamFactor, annuity } from './conversions.js';

export function validate(m) {
  const errs = [], ids = new Set();
  if (!m || !m.id) errs.push('model needs an id');
  if (!m.cost || !validDist(m.cost.upfront ?? 0) || !validDist(m.cost.annual ?? 0)) errs.push('cost needs upfront and/or annual as numbers or distributions (USD)');
  if (!Array.isArray(m.nodes) || !m.nodes.length) errs.push('model needs at least one node');
  for (const n of m.nodes || []) {
    if (ids.has(n.id)) errs.push('duplicate node ' + n.id); ids.add(n.id);
    if (!UNITS[n.unit]) errs.push(n.id + ': unknown unit ' + n.unit);
    if (!GRADES[n.grade]) errs.push(n.id + ': grade must be A, B, C or D');
    if (!validDist(n.amount)) errs.push(n.id + ': amount must be a number or distribution');
    if (!n.source) errs.push(n.id + ': every link names its source (or "assumption")');
  }
  for (const n of m.nodes || []) if (n.parent && !ids.has(n.parent)) errs.push(n.id + ': unknown parent ' + n.parent);
  if (!errs.length) { try { order(m.nodes); } catch (e) { errs.push(e.message); } }
  return errs;
}
export function order(nodes) {
  const by = new Map(nodes.map(n => [n.id, n])), out = [], state = new Map();
  const visit = (n) => { if (state.get(n.id) === 2) return; if (state.get(n.id) === 1) throw new Error('cycle at ' + n.id); state.set(n.id, 1); if (n.parent) visit(by.get(n.parent)); state.set(n.id, 2); out.push(n); };
  nodes.forEach(visit); return out;
}
const depth = (n, by) => (n.parent ? 1 + depth(by.get(n.parent), by) : 1);

function rankCorr(a, b) {
  const rk = xs => { const idx = xs.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]), r = new Array(xs.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
  const x = rk(a), y = rk(b), n = x.length, mx = (n - 1) / 2; let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - mx); sxx += (x[i] - mx) ** 2; syy += (y[i] - mx) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

export function score(model, { draws = 4000, seed = 1 } = {}) {
  const errs = validate(model); if (errs.length) throw new Error('invalid model: ' + errs.join('; '));
  const rand = rng(seed), nodes = order(model.nodes), by = new Map(nodes.map(n => [n.id, n]));
  const params = { ...Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, v.dist])), ...(model.params || {}) };
  const orders = new Map(nodes.map(n => [n.id, n.order ?? depth(n, by)]));
  const total = [], ratio = [], first = [], costs = [], unintended = [], beat = [], contrib = new Map(nodes.map(n => [n.id, []])), pdraw = new Map(Object.keys(params).map(k => [k, []]));
  const gradeShare = { A: 0, B: 0, C: 0, D: 0 }, orderShare = {}; let absTotal = 0, beats = 0, positive = 0;
  for (let i = 0; i < draws; i++) {
    const p = {}; for (const k of Object.keys(params)) { p[k] = sample(params[k], rand); pdraw.get(k).push(p[k]); }
    const amt = new Map(), H = new Map(); let sum = 0, sumFirst = 0, neg = 0;
    for (const n of nodes) {
      const a = (n.parent ? amt.get(n.parent) : 1) * sample(n.amount, rand); amt.set(n.id, a);
      const h = (n.parent ? H.get(n.parent) : 1) * sample(GRADES[n.grade].haircut, rand); H.set(n.id, h);
      const u = UNITS[n.unit], s = n.sign === -1 || n.kind === 'unintended' ? -1 : 1;
      const per = u.per(p, n, rand());
      const f = u.stream ? streamFactor({ years: sample(n.years ?? 1, rand), lag: n.lag ?? 0, decay: n.decay }, p.discount) : (1 / Math.pow(1 + p.discount, n.lag ?? 0));
      const w = a * s * h * per * f; // an unintended node's amount is a magnitude; its sign flips it
      contrib.get(n.id).push(w); sum += w; if (orders.get(n.id) === 1 && s === 1) sumFirst += w; if (w < 0) neg += w;
      gradeShare[n.grade] += Math.abs(w); orderShare[orders.get(n.id)] = (orderShare[orders.get(n.id)] || 0) + Math.abs(w); absTotal += Math.abs(w);
    }
    const c = Math.max(1e-9, sample(model.cost.upfront ?? 0, rand) + sample(model.cost.annual ?? 0, rand) * annuity(model.cost.years ?? 1, p.discount));
    total.push(sum); first.push(sumFirst / c * 1000); costs.push(c); ratio.push(sum / c * 1000); unintended.push(neg / c * 1000);
    if (sum > 0) positive++;
    if (model.benchmark) { const b = sample(model.benchmark.wellby_per_1000, rand); if (sum / c * 1000 > b) beats++; }
  }
  const sens = [...contrib.entries()].map(([id, xs]) => ({ id, kind: 'node', corr: rankCorr(xs, total) }))
    .concat([...pdraw.entries()].filter(([, xs]) => xs.some(x => x !== xs[0])).map(([id, xs]) => ({ id, kind: 'parameter', corr: rankCorr(xs, total) })))
    .sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr));
  const share = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, absTotal ? v / absTotal : 0]));
  const statuses = { ...Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, (model.params && model.params[k]) ? 'assumption' : v.status])) };
  const out = {
    model: model.id, draws, seed, metric: 'WELLBY', cost_usd: summarize(costs), wellby_total: summarize(total), wellby_per_1000_usd: summarize(ratio),
    first_order_only_per_1000_usd: summarize(first), higher_order_uplift_p50: summarize(ratio).p50 - summarize(first).p50,
    unintended_per_1000_usd: summarize(unintended), prob_net_positive: positive / draws,
    evidence_share: share(gradeShare), order_share: share(orderShare), sensitivity: sens.slice(0, 8),
    rank_key: summarize(ratio).p25, // conservative: the 25th percentile, so a wide, weakly evidenced estimate ranks below a tight, well evidenced one
    assumptions_used: Object.fromEntries(Object.entries(statuses).map(([k, s]) => [k, s])),
    nodes: nodes.map(n => ({ id: n.id, label: n.label, order: orders.get(n.id), kind: n.kind, grade: n.grade, source: n.source, wellby_total: summarize(contrib.get(n.id)) })),
  };
  if (model.benchmark) out.benchmark = { id: model.benchmark.id, label: model.benchmark.label, prob_beats: beats / draws };
  return out;
}
