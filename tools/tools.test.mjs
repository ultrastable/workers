// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyse } from './fleet_graph.mjs';
import { runAll, runSuite } from './run-suites.mjs';

test('fleet_graph: blast radius of a leaf file lists transitive importers, plus declared edges', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'fg-')); mkdirSync(path.join(d, 'src'));
  writeFileSync(path.join(d, 'src/a.js'), "import './b.js';"); writeFileSync(path.join(d, 'src/b.js'), "import './c.js';"); writeFileSync(path.join(d, 'src/c.js'), '');
  writeFileSync(path.join(d, 'src/x.js'), '');
  const r = await analyse({ root: d, changed: ['src/c.js'], declared: [['src/x.js', 'src/a.js']] });
  assert.deepEqual(r.affected, ['src/a.js', 'src/b.js', 'src/x.js']);
  assert.ok(r.sources[0].ok);
});
test('run-suites: runs every suite, reports failure reason, filters by name', () => {
  const res = runAll([{ name: 'ok', cmd: 'true' }, { name: 'bad', cmd: 'echo boom >&2; exit 3' }, { name: 'also', cmd: 'true' }]);
  assert.deepEqual(res.map(r => r.ok), [true, false, true]);
  assert.match(res[1].reason, /boom/); assert.equal(res[1].code, 3);
  assert.equal(runAll([{ name: 'a', cmd: 'true' }, { name: 'b', cmd: 'true' }], ['b']).length, 1);
  assert.equal(runSuite({ name: 'x', cmd: 'true' }, () => ({ status: null, error: new Error('spawn failed') })).ok, false);
});
