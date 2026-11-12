// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The blocked-extraction register is data a loop reads: every row needs a blocker, a closing probe, a next action and a
// disposition, and a row whose test-file probe now exists must be removed (a closed probe is not a blocker).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const reg = JSON.parse(readFileSync(ROOT + 'ops/extraction-unblocked.json', 'utf8'));

test('every blocked item states blocker, closing probe, next action and disposition; ids are unique', () => {
  assert.ok(reg.items.length >= 5);
  const ids = new Set();
  for (const it of reg.items) {
    for (const k of ['id', 'item', 'blocker', 'blocker_kind', 'closing_probe', 'next_action', 'disposition']) assert.ok(String(it[k] || '').trim(), `${it.id}: ${k} missing`);
    assert.equal(it.disposition, 'blocked');
    assert.ok(it.probe && it.probe.kind, `${it.id}: machine-readable probe missing`);
    assert.ok(!ids.has(it.id), 'duplicate id ' + it.id); ids.add(it.id);
  }
});

test('a design-blocked item carries the default that is in effect', () => {
  for (const it of reg.items.filter(i => i.blocker_kind === 'design_default')) assert.ok(String(it.default_in_effect || '').length > 20, it.id);
});

test('a test-file probe that already passes its existence check means the row is stale', () => {
  const stale = reg.items.filter(i => i.probe.kind === 'test_file' && existsSync(ROOT + i.probe.path)).map(i => i.id);
  assert.deepEqual(stale, [], 'remove rows whose closing probe file now exists');
});

test('the register names every item of issue #99 and no tenant', () => {
  assert.equal(reg.source_issue, 99);
  assert.deepEqual(reg.items.map(i => i.id).sort(), ['agents-do-wrapper', 'claims-feed', 'containers-image', 'deploy-agent-in-org-tick', 'github-pull-sync']);
});
