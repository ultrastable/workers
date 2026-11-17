// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from './index.js';

const mem = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const P = { source: 'test', url: 'https://example.org/a', at: '2026-11-17' };
const RULES = [
  { id: 'unsolved', kind: 'problem', lacks: { rel: 'addresses', dir: 'in', to: 'solution' }, ask: n => `What works against ${n.label}?` },
  { id: 'unadopted', kind: 'solution', lacks: { rel: 'implementable_by', to: 'agency' }, ask: n => `Who can implement ${n.label}?` },
];
async function seeded() {
  const g = createGraph({ store: mem() });
  await g.addNode({ id: 'p:a', kind: 'problem', label: 'A', provenance: P });
  await g.addNode({ id: 'p:b', kind: 'problem', label: 'B' });
  await g.addNode({ id: 's:x', kind: 'solution', label: 'X', provenance: P });
  await g.addNode({ id: 'g:1', kind: 'agency', label: 'Agency 1' });
  await g.addEdge({ src: 's:x', rel: 'addresses', dst: 'p:a', provenance: P });
  return g;
}

test('gaps find problems without a confirmed solution and solutions without an agency', async () => {
  const g = await seeded();
  assert.deepEqual((await g.gaps(RULES)).map(x => `${x.rule}:${x.node}`).sort(), ['unadopted:s:x', 'unsolved:p:b']);
});

test('questions are generated from gaps in the tenant\'s wording, in stable order', async () => {
  const g = await seeded();
  assert.deepEqual((await g.questions(RULES)).map(q => q.text), ['Who can implement X?', 'What works against B?']);
});

test('a proposed edge is a lead: it does not fill a gap until confirmed with provenance', async () => {
  const g = await seeded();
  await g.propose({ src: 's:x', rel: 'implementable_by', dst: 'g:1', why: 'runs a programme' });
  assert.equal((await g.gaps(RULES)).length, 2);
  await assert.rejects(() => g.confirm({ src: 's:x', rel: 'implementable_by', dst: 'g:1' }), /provenance/);
  await g.confirm({ src: 's:x', rel: 'implementable_by', dst: 'g:1', provenance: P });
  assert.deepEqual((await g.gaps(RULES)).map(x => x.rule), ['unsolved']);
});

test('neighbors, backlinks and bounded reach follow confirmed edges only', async () => {
  const g = await seeded();
  await g.propose({ src: 's:x', rel: 'implementable_by', dst: 'g:1' });
  assert.deepEqual((await g.neighbors('p:a', { dir: 'in' })).map(n => n.node.id), ['s:x']);
  assert.equal((await g.neighbors('s:x')).length, 1);
  assert.deepEqual((await g.reach('s:x', { depth: 2 })).map(r => r.node.id), ['p:a']);
});

test('edges need both ends, nodes merge provenance, validate flags unsourced confirmed edges', async () => {
  const g = await seeded();
  await assert.rejects(() => g.addEdge({ src: 's:x', rel: 'r', dst: 'nope' }), /missing end/);
  await g.addNode({ id: 'p:a', kind: 'problem', props: { z: 1 }, provenance: { source: 'second' } });
  const n = await g.node('p:a');
  assert.equal(n.provenance.length, 2); assert.equal(n.props.z, 1); assert.equal(n.label, 'A');
  await g.addEdge({ src: 'g:1', rel: 'knows', dst: 's:x' });
  assert.deepEqual((await g.validate()).map(v => v.kind), ['no_provenance']);
});

test('the graph persists through the store and round-trips through export/import', async () => {
  const store = mem(); const a = createGraph({ store });
  await a.addNode({ id: 'n1', kind: 'k' }); await a.addNode({ id: 'n2', kind: 'k' }); await a.addEdge({ src: 'n1', rel: 'r', dst: 'n2', provenance: P });
  const b = createGraph({ store }); assert.equal((await b.edges()).length, 1);
  const c = createGraph({ store: mem() }); await c.import(await b.export());
  assert.deepEqual(await c.stats(), { nodes: { k: 2 }, edges: { 'r:confirmed': 1 } });
});
