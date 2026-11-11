// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { extractEdges, normalize, ingest, declare, blastRadius } from './index.js';

const mig = fileURLToPath(new URL('./migrations/', import.meta.url));
const files = [
  { path: 'core/a.js', text: "import { x } from './b.js';\nconst c = require('../lib/c.js');\nimport 'pkg';" },
  { path: 'core/b.js', text: "export * from './d.js';" },
  { path: 'core/d.js', text: '' }, { path: 'lib/c.js', text: '' },
];
const mk = sources => ({ db: makeDb([mig]), now: () => 0, sources });

test('edges: relative imports only, resolved against the importing file', () => {
  assert.deepEqual(extractEdges('core/a.js', files[0].text).sort(), ['core/b.js', 'lib/c.js']);
  assert.equal(normalize('a/b/c.js', '../../x.js'), 'x.js');
});
test('blast radius is transitive and cycle safe', async () => {
  const ctx = mk([{ name: 's1', list: async () => files }]);
  await ingest(ctx); await declare(ctx, 'core/d.js', 'core/a.js');   // cycle a -> b -> d -> a
  const r = await blastRadius(ctx, ['core/d.js']);
  assert.deepEqual(r.affected, ['core/a.js', 'core/b.js']);
});
test('no single route: a failing source is reported, the other still builds the graph', async () => {
  const ctx = mk([{ name: 'broken', list: async () => { throw new Error('tree api down'); } }, { name: 'local', list: async () => files }]);
  const rep = await ingest(ctx);
  assert.deepEqual(rep.map(r => r.ok), [false, true]);
  assert.deepEqual((await blastRadius(ctx, ['lib/c.js'])).affected, ['core/a.js']);
});
