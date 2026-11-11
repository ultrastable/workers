// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The separation guard (code and configuration only; documentation may cite QNFO as the origin and first customer):
// the product code must not name, call or depend on QNFO. Everything tenant-specific is configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCAN = ['core', 'adapters', 'bootstrap', 'agents', 'autonomy', 'runtimes', 'products', 'apps', 'tests', 'ultrastable.json', 'IDEA.md', 'package.json'];
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'test-fixtures']);
const FORBIDDEN = /qnfo|quniverse|\bq08\b|rwnq8|edb167b78c9fb901ea5bca3ce58ccc4b|workers\.dev\/[^\s]*qnfo/i;
// Files whose purpose is to ban or detect tenant names (negative lists and boundary tests).
const NEGATIVE_LIST_FILES = ['test_boundary.py', 'test_config.py', 'publish.json'];
const ALLOWED_LINE = /SPDX-License-Identifier|Copyright \(c\) 2026|no-qnfo|FORBIDDEN/; // header and this guard itself

function* walk(p) {
  const st = statSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isFile()) { yield p; return; }
  for (const n of readdirSync(p)) if (!SKIP_DIRS.has(n)) yield* walk(path.join(p, n));
}

test('no QNFO identifier, host, account id or handle appears in the product code', () => {
  const hits = [];
  for (const entry of SCAN) for (const f of walk(path.join(ROOT, entry))) {
    if (f.endsWith('no-qnfo.test.js') || NEGATIVE_LIST_FILES.some(n => f.endsWith(n))) continue;
    if (!/\.(js|mjs|json|jsonc|py|sql|sh|toml|yml|yaml|html)$/.test(f) && !/Dockerfile$/.test(f)) continue;
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (FORBIDDEN.test(line) && !ALLOWED_LINE.test(line)) hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, [], 'QNFO-specific text found in product code:\n' + hits.join('\n'));
});
