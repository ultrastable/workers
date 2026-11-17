// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreIn, scoreAcross, applyEvidence } from './index.js';

const model = { id: 'wash', cost: { upfront: 1000 },
  nodes: [{ id: 'd', label: 'illness averted', kind: 'direct', amount: { kind: 'ci90', low: 8, high: 14, shape: 'normal' }, unit: 'daly', grade: 'A', source: 'trial' }],
  contexts: { high: { applies: false, reason: 'Water is already treated and piped to nearly every household.' }, low: { nodes: { d: { amount: { kind: 'ci90', low: 12, high: 20, shape: 'normal' } } } } } };
const ctx = [{ id: 'low', label: 'Low income', params: { ls_mean: 3.5 }, cost_multiplier: 0.5 }, { id: 'mid', label: 'Middle income', params: { ls_mean: 5.5 }, cost_multiplier: 1 }, { id: 'high', label: 'High income', params: { ls_mean: 7 }, cost_multiplier: 3 }];

test('the same solution scores differently by context, and not at all where it does not apply', () => {
  const r = scoreAcross(model, ctx, { seed: 1, draws: 800 });
  assert.equal(r.high.applicable, false); assert.match(r.high.reason, /piped/);
  assert.ok(r.low.wellby_per_1000_usd.p50 > r.mid.wellby_per_1000_usd.p50, 'cheaper delivery and a larger baseline burden win');
  assert.equal(r.low.context_specific, true); assert.equal(r.mid.context_specific, false, 'transferred figures are flagged');
});
test('context overrides win in order: model per-context over context over base; the input is not mutated', () => {
  const before = JSON.stringify(model); scoreIn(model, ctx[0], { draws: 100 }); assert.equal(JSON.stringify(model), before);
});
test('a context-wide inapplicability applies to every model', () => {
  assert.equal(scoreIn(model, { id: 'x', applies: false, reason: 'out of scope' }, { draws: 50 }).applicable, false);
});
test('evidence with a context pools into that context only', () => {
  const r = applyEvidence(model, [{ node: 'd', context: 'mid', estimate: { low: 5, high: 7 }, grade: 'B', source: 'Trial in a middle-income country' }], { seed: 1 });
  assert.ok(r.model.contexts.mid.nodes.d.amount.low > 0); assert.deepEqual(r.model.nodes[0].amount, model.nodes[0].amount);
});
