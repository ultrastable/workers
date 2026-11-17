// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Context: the same intervention has different costs, baselines and effects, or does not apply at all, in places at different stages of development.
// A context is tenant data: { id, label, params?: { parameterId: dist }, cost_multiplier?: dist, applies?: false, reason? } (for example a development tier).
// A model carries per-context facts in model.contexts[id] = { applies?: false, reason?, params?, cost_multiplier?, nodes?: { nodeId: { amount?, grade? } } },
// applied on top of the context's own overrides. A context a model does not mention inherits the model's base figures, flagged as "transferred".
import { score } from './model.js';

export function inContext(model, context) {
  const mc = (model.contexts && model.contexts[context.id]) || {};
  const applies = mc.applies === false || context.applies === false ? false : true;
  const reason = mc.applies === false ? mc.reason : context.applies === false ? context.reason : null;
  const next = structuredClone(model);
  next.params = { ...(model.params || {}), ...(context.params || {}), ...(mc.params || {}) };
  const cm = mc.cost_multiplier ?? context.cost_multiplier;
  if (cm !== undefined) next.cost = { ...next.cost, upfront: scale(next.cost.upfront ?? 0, cm), annual: scale(next.cost.annual ?? 0, cm) };
  for (const n of next.nodes) { const o = mc.nodes && mc.nodes[n.id]; if (o) { if (o.amount !== undefined) n.amount = o.amount; if (o.grade) n.grade = o.grade; } }
  return { model: next, applies, reason, specific: !!(model.contexts && model.contexts[context.id]) };
}
// product of a cost and a multiplier, both numbers or ci90 lognormal-ish; keeps the result a distribution without losing either range.
function scale(cost, m) {
  if (typeof m === 'number') return typeof cost === 'number' ? cost * m : { ...cost, low: cost.low * m, high: cost.high * m, min: cost.min * m, max: cost.max * m, mode: cost.mode * m };
  const lo = typeof cost === 'number' ? cost : (cost.low ?? cost.min), hi = typeof cost === 'number' ? cost : (cost.high ?? cost.max);
  return { kind: 'ci90', shape: 'lognormal', low: Math.max(1e-9, lo * m.low), high: Math.max(1e-9, hi * m.high) };
}
export function scoreIn(model, context, opts) {
  const c = inContext(model, context);
  if (!c.applies) return { model: model.id, context: context.id, applicable: false, reason: c.reason || 'not applicable here' };
  return { ...score(c.model, opts), context: context.id, applicable: true, context_specific: c.specific };
}
export function scoreAcross(model, contexts, opts) {
  return Object.fromEntries(contexts.map(c => [c.id, scoreIn(model, c, opts)]));
}
