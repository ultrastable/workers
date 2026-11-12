// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Documentation tests (issue #23, T19-6): relative links resolve, and requirement ids look like requirement ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const docs = ['README.md', ...readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => 'docs/' + f)];

test('relative markdown links in README and docs resolve to files', () => {
  const broken = [];
  for (const d of docs) {
    const text = readFileSync(join(root, d), 'utf8');
    for (const m of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      const href = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) continue;
      if (!existsSync(resolve(root, dirname(d), href))) broken.push(d + ' -> ' + href);
    }
  }
  assert.deepEqual(broken, []);
});

test('requirement ids use the US-NN-RNN or US-SPEC-NN shape', () => {
  const bad = [];
  for (const d of docs) {
    const text = readFileSync(join(root, d), 'utf8');
    for (const m of text.matchAll(/US-[A-Z0-9-]+/g)) {
      if (!/^US-(\d{2}-R\d{2}|SPEC-\d{2}|\d{2})$/.test(m[0]) && !/^US-(\d{2}-R\d{2})-/.test(m[0])) bad.push(d + ': ' + m[0]);
    }
  }
  assert.deepEqual([...new Set(bad)], []);
});
