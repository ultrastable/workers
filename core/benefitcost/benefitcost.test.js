// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { score, validate, applyEvidence, nextEvidenceTargets, refineLoop, rng, sample, summarize } from './index.js';

const cash = ({ nodes: extra = [], ...over } = {}) => ({ id: 'm', cost: { upfront: 1000 }, benchmark: { id: 'b', label: 'bench', wellby_per_1000: { kind: 'ci90', low: 2, high: 8, shape: 'lognormal' } }, nodes: [
  { id: 'direct', label: 'consumption doubles for a year', kind: 'direct', amount: { kind: 'ci90', low: 0.8, high: 1.2, shape: 'normal' }, unit: 'consumption_doubling_year', years: 1, grade: 'A', source: 'trial' },
  ...extra], ...over });

test('seeded runs repeat exactly; different seeds differ', () => {
  const m = cash(); assert.deepEqual(score(m, { seed: 3, draws: 500 }).wellby_per_1000_usd, score(m, { seed: 3, draws: 500 }).wellby_per_1000_usd);
  assert.notEqual(score(m, { seed: 4, draws: 500 }).wellby_per_1000_usd.p50, score(m, { seed: 3, draws: 500 }).wellby_per_1000_usd.p50);
});
test('sampling a 90% interval reproduces the interval', () => {
  const r = rng(7), xs = Array.from({ length: 20000 }, () => sample({ kind: 'ci90', low: 10, high: 30, shape: 'lognormal' }, r)), s = summarize(xs);
  assert.ok(Math.abs(s.p5 - 10) < 0.6 && Math.abs(s.p95 - 30) < 1.5, JSON.stringify(s));
});
test('a weakly evidenced second-order effect is worth less than the same effect with strong evidence, and inherits the parent haircut', () => {
  const mk = g => cash({ nodes: [{ id: 'spill', label: 'neighbours benefit', kind: 'spillover', parent: 'direct', amount: 0.3, unit: 'consumption_doubling_year', years: 1, grade: g, source: 'x' }] });
  const strong = score(mk('A'), { seed: 1 }).wellby_per_1000_usd.p50, weak = score(mk('D'), { seed: 1 }).wellby_per_1000_usd.p50;
  assert.ok(strong > weak);
  const r = score(mk('D'), { seed: 1 }); assert.ok(r.order_share['2'] > 0 && r.evidence_share.D > 0);
});
test('unintended consequences reduce the total and are reported', () => {
  const base = score(cash(), { seed: 1 }).wellby_per_1000_usd.p50;
  const m = cash({ nodes: [{ id: 'harm', label: 'local inflation', kind: 'unintended', parent: 'direct', amount: 0.2, unit: 'consumption_doubling_year', years: 1, grade: 'C', source: 'x' }] });
  const r = score(m, { seed: 1 }); assert.ok(r.wellby_per_1000_usd.p50 < base); assert.ok(r.unintended_per_1000_usd.p50 < 0);
});
test('first-order-only and full results differ when there are higher-order effects', () => {
  const m = cash({ nodes: [{ id: 's', label: 's', kind: 'multiplier', parent: 'direct', amount: 0.5, unit: 'wellby', years: 3, grade: 'B', source: 'x' }] });
  assert.ok(score(m, { seed: 1 }).higher_order_uplift_p50 > 0);
});
test('deaths averted convert through two routes and carry the neutral point as the dominant uncertainty', () => {
  const m = { id: 'd', cost: { upfront: 100000 }, nodes: [{ id: 'deaths', label: 'deaths averted', kind: 'direct', amount: { kind: 'ci90', low: 8, high: 14, shape: 'normal' }, unit: 'death_averted', life_years: 50, grade: 'A', source: 'review' }] };
  const r = score(m, { seed: 2 }); assert.ok(r.wellby_per_1000_usd.p50 > 0 && r.prob_net_positive > 0.9);
  assert.ok(r.sensitivity.slice(0, 4).some(s => ['neutral_point', 'moral_weight_death_u5', 'consumption_doubling_wellby'].includes(s.id)));
  assert.equal(r.assumptions_used.sd_ls, 'cited');
});
test('invalid models are refused: unknown unit, missing source, cycle', () => {
  assert.ok(validate(cash({ nodes: [{ id: 'x', amount: 1, unit: 'dollars', grade: 'A', source: 's' }] })).length);
  assert.ok(validate(cash({ nodes: [{ id: 'x', amount: 1, unit: 'wellby', grade: 'A' }] })).some(e => /source/.test(e)));
  const cyc = cash({ nodes: [{ id: 'a', parent: 'b', amount: 1, unit: 'wellby', grade: 'A', source: 's' }, { id: 'b', parent: 'a', amount: 1, unit: 'wellby', grade: 'A', source: 's' }] });
  assert.ok(validate(cyc).some(e => /cycle/.test(e)));
  assert.throws(() => score(cyc));
});
test('new evidence narrows the interval, can raise the grade, and is never pooled twice', () => {
  const m = cash({ nodes: [{ id: 'spill', label: 's', kind: 'spillover', parent: 'direct', amount: { kind: 'ci90', low: 0.05, high: 0.6, shape: 'lognormal' }, unit: 'wellby', years: 2, grade: 'D', source: 'assumption' }] });
  const ev = { node: 'spill', estimate: { low: 0.2, high: 0.3 }, grade: 'B', source: 'Trial X 2026' };
  const r = applyEvidence(m, [ev], { seed: 1 }); const n = r.model.nodes[1];
  assert.equal(n.grade, 'B'); assert.equal(n.source, 'Trial X 2026'); assert.ok(n.amount.high / n.amount.low < 0.6 / 0.05);
  assert.equal(applyEvidence(r.model, [ev]).log[0].applied, false);
  assert.equal(m.nodes[1].grade, 'D', 'input model is not mutated');
});
test('next-evidence targets prefer influential, weakly graded links', () => {
  const m = cash({ nodes: [{ id: 'big', label: 'big weak', kind: 'multiplier', parent: 'direct', amount: { kind: 'ci90', low: 0.1, high: 3, shape: 'lognormal' }, unit: 'wellby', years: 5, grade: 'D', source: 'assumption' }] });
  assert.equal(nextEvidenceTargets(m, { top: 1 })[0].node, 'big');
});
test('the loop asks where evidence is worth most, pools it, saves, and reports what moved', async () => {
  const m = cash({ nodes: [{ id: 'big', label: 'big weak', kind: 'multiplier', parent: 'direct', amount: { kind: 'ci90', low: 0.1, high: 3, shape: 'lognormal' }, unit: 'wellby', years: 5, grade: 'D', source: 'assumption' }] });
  const saved = [];
  const rep = await refineLoop({ load: async () => [m], save: async (mm, res, ch) => saved.push({ mm, res, ch }),
    evidenceFor: async (_m, t) => (t.node === 'big' ? [{ node: 'big', estimate: { low: 0.1, high: 0.2 }, grade: 'A', source: 'Review Y' }] : []), at: '2026-11-17' });
  assert.equal(rep.applied, 1); assert.ok(rep.moved[0].p50_to < rep.moved[0].p50_from); assert.equal(saved[0].ch, true);
  const rep2 = await refineLoop({ load: async () => [saved[0].mm], save: async () => {}, evidenceFor: async () => [] });
  assert.equal(rep2.applied, 0); assert.equal(rep2.models, 1);
});
