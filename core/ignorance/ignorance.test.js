// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, run, UIA, KINDS, ruleRedTeam, redTeam, sanitizeModel, checkAnswers, administer, frontier, publicView, estimateMiner, contradictionMiner, unexploredMiner, minersFor } from './index.js';
import { createGraph } from '../kgraph/index.js';

const mem = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => void m.set(k, v) }; };
const T = { v: Date.UTC(2026, 10, 17, 12) };
const reg = (store = mem()) => createRegistry({ store, now: () => T.v });
const sol = (id, o = {}) => ({ id, type: 'solution', title: 'Solution ' + id, claim: 'Cuts deaths by a quarter.', evidence: [{ src: 'Trial A', finding: 'x' }], design: 'trial', verdict: 'works', works_where: 'Ghana', who: 'Ministries', limits: 'Only tertiary units.', problem_ids: ['p1'], domain: 'Health', ...o });

test('the audit instrument has five phases and fifteen questions, and the protocol is enforced', () => {
  assert.equal(UIA.questions.length, 15); assert.equal(UIA.phases.length, 5);
  assert.equal(administer(sol('a')).length, 15);
  const answers = UIA.questions.map(q => ({ n: q.n, answer: q.n === 15 ? 'What does it cost per life?' : 'we do not know' }));
  assert.deepEqual(checkAnswers(answers), { complete: true, problems: [], next_seed: 'What does it cost per life?' });
  assert.equal(checkAnswers(answers.slice(1)).complete, false);
  assert.equal(checkAnswers([{ n: 1, answer: 'n/a', inapplicable: true }, ...answers.slice(1)]).problems[0].problem, 'inapplicable without a stretch');
});

test('every gap kind belongs to one of the three regions', () => {
  assert.deepEqual([...new Set(Object.values(KINDS).map(k => k.region))].sort(), ['ignorance_about_ignorance', 'known_unknown', 'unknown_unknown']);
});

test('miners find unstated assumptions, weak designs, single sources, missing intervals and untouched problems', () => {
  const subjects = [sol('a', { design: 'observational', effect: { value: 1, low: 0.2, high: 2, unit: 'x' } }), { id: 'p2', type: 'problem', title: 'Empty problem' }];
  const kinds = minersFor().flatMap(m => m({ subjects })).map(g => g.kind + ':' + g.id.split(':')[2].replace(/-[a-z0-9]+$/, ''));
  for (const k of ['untested_assumption', 'evidence_gap', 'estimate_gap', 'unexplored_domain']) assert.ok(kinds.some(x => x.startsWith(k)), k);
  assert.ok(estimateMiner({ subjects }).some(g => /spans more than threefold/.test(g.text)));
  assert.ok(unexploredMiner({ subjects }).some(g => g.subject === 'p2'));
});

test('contradictions: a mixed verdict, and two verdicts that differ for one problem', () => {
  const g = contradictionMiner({ subjects: [sol('a'), sol('b', { verdict: 'mixed' })] });
  assert.ok(g.some(x => x.subject === 'b') && g.some(x => x.subject === 'p1'));
});

test('the deterministic red team challenges every entry with a falsifier and needs no model', () => {
  const f = ruleRedTeam(sol('a', { design: 'guidance' }));
  assert.ok(f.length >= 8); assert.ok(f.every(x => x.falsifier && x.q >= 1 && x.q <= 15));
  assert.deepEqual([...new Set(f.map(x => x.pass))].sort(), ['inversion', 'premortem', 'red_team']);
  assert.ok(f.some(x => x.severity === 3), 'a causal claim on a weak design is a severe challenge');
});

test('model output is untrusted: validated, capped, tagged, and refused from the author family', async () => {
  const bad = { family: 'x', findings: [{ pass: 'bogus', q: 99, challenge: 'short' }] };
  assert.equal(sanitizeModel(bad).length, 0);
  const good = { family: 'other', findings: Array.from({ length: 20 }, (_, i) => ({ pass: 'inversion', q: 4, challenge: 'What if the opposite were true for case number ' + i + '?', severity: 3, falsifier: 'x' })) };
  const out = sanitizeModel(good, { author_family: 'author' }); assert.equal(out.length, 8); assert.equal(out[0].source, 'model');
  assert.throws(() => sanitizeModel({ family: 'author', findings: [] }, { author_family: 'author' }), /different model family/);
  const r = await redTeam(sol('a'), { model: async () => ({ family: 'author', findings: [] }), author_family: 'author' });
  assert.match(r.model_error, /different model family/); assert.ok(r.findings.length >= 6, 'the rule floor still ran');
  const r2 = await redTeam(sol('a'), { model: async () => { throw new Error('down'); } }); assert.equal(r2.model_error, 'down');
});

test('a run records gaps, challenges the stalest subjects first, and never loses one (accounting invariant)', async () => {
  const registry = reg(), subjects = [sol('a'), sol('b'), sol('c'), sol('d'), { id: 'p1', type: 'problem', title: 'P1' }];
  const r1 = await run({ registry, subjects, now: () => T.v, budget: 2 });
  assert.equal(r1.metrics.targets.length, 2); assert.ok(r1.metrics.open > 10); assert.equal(r1.metrics.audit.balanced, true);
  assert.ok(r1.frontier.length > 0 && r1.frontier.some(q => q.type === 'solution_candidate'));
  T.v += 864e5;
  const r2 = await run({ registry, subjects, now: () => T.v, budget: 2 });
  assert.ok(!r2.metrics.targets.some(t => r1.metrics.targets.includes(t)), 'the next pass goes to subjects not yet challenged');
  assert.ok(r2.metrics.challenged_share > r1.metrics.challenged_share);
  assert.ok((await registry.list({ kind: 'audit_coverage' })).length >= 1, 'ignorance about ignorance is itself measured');
});

test('closing needs a disposition and evidence; a fixed condition closes itself with evidence; a regression reopens', async () => {
  const registry = reg(), s = sol('a', { assumptions: [{ text: 'Nurses are trained', tested: false }], effect: { value: 1, low: 1, high: 2, unit: 'u' }, bca: { higher_order: ['x'], counterfactual: 'y' } });
  await run({ registry, subjects: [s], now: () => T.v, budget: 0 });
  const open = await registry.list({ kind: 'untested_assumption', status: 'open' }); assert.ok(open.some(g => /Nurses/.test(g.text)));
  await assert.rejects(() => registry.close(open[0].id, { disposition: 'resolved' }), /evidence/);
  await assert.rejects(() => registry.close(open[0].id, { disposition: 'gone', evidence: 'x' }), /disposition/);
  s.assumptions[0].tested = true;
  const r = await run({ registry, subjects: [s], now: () => T.v, budget: 0 });
  assert.ok(r.metrics.closed >= 1);
  const c = (await registry.list({ status: 'closed' })).find(g => /Nurses/.test(g.text)); assert.equal(c.disposition, 'resolved'); assert.match(c.evidence, /no longer reports/);
  s.assumptions[0].tested = false;
  const r3 = await run({ registry, subjects: [s], now: () => T.v, budget: 0 }); assert.ok(r3.metrics.reopened >= 1);
  assert.equal((await registry.audit()).balanced, true);
});

test('the graph feeds the registry: missing edges and contradicts edges become gaps and questions', async () => {
  const graph = createGraph({ store: mem() });
  await graph.addNode({ id: 's1', kind: 'solution', label: 'S1', provenance: { source: 't' } }); await graph.addNode({ id: 's2', kind: 'solution', label: 'S2', provenance: { source: 't' } });
  await graph.addEdge({ src: 's1', rel: 'contradicts', dst: 's2', why: 'opposite sign in two trials', provenance: { source: 't' } });
  const rules = [{ id: 'needs-cost', kind: 'solution', lacks: { rel: 'costs' }, ask: n => `What does ${n.label} cost per person?` }];
  const registry = reg(); const r = await run({ registry, subjects: [], graph, rules, miners: [], now: () => T.v });
  const all = await registry.list(); assert.ok(all.some(g => g.kind === 'missing_edge' && /cost per person/.test(g.text)) && all.some(g => g.kind === 'contradiction' && /opposite sign/.test(g.text)));
  assert.ok(r.frontier.some(q => q.type === 'question'));
});

test('stagnation widens the next pass: when nothing new is found run after run, the loop challenges more, not less', async () => {
  const registry = reg(), subjects = [sol('a', { assumptions: [{ text: 'x', tested: true }], effect: { value: 1, low: 1, high: 2 }, bca: { higher_order: ['m'], counterfactual: 'c' }, evidence: [{}, {}], works_where: 'Ghana, India' })];
  let r; for (let i = 0; i < 6; i++) { T.v += 864e5; r = await run({ registry, subjects, now: () => T.v, budget: 1 }); }
  assert.equal(r.metrics.opened, 0); assert.equal(r.metrics.stagnant, true); assert.equal(r.widen_next, 1);
});

test('public view lists open gaps with what would close them, and the last closed ones', async () => {
  const registry = reg(); await run({ registry, subjects: [sol('a')], now: () => T.v, budget: 1 });
  const v = await publicView(registry, 'a'); assert.ok(v.challenged_at && v.open.length > 5 && v.open.every(g => g.how && g.region));
});

test('frontier orders by priority and turns unexplored domains into problem candidates', () => {
  const f = frontier([{ id: 'a', kind: 'unexplored_domain', severity: 3, text: 'x', status: 'open' }, { id: 'b', kind: 'red_team', severity: 1, text: 'y', status: 'open' }, { id: 'c', kind: 'red_team', severity: 3, text: 'z', status: 'closed' }]);
  assert.deepEqual(f.map(q => q.type), ['problem_candidate', 'question']);
});
