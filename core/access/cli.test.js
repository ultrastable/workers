// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lintAsks } from './cli.mjs';

test('text that asks a person for a capability the probe shows present or unproven is a failure; for a proven-missing one it is not', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'lint-'));
  const f = path.join(d, 'HANDOFF.md'); writeFileSync(f, 'Please add the Cloudflare secret to the repository settings.\n');
  const phrases = [{ pattern: 'please add the cloudflare secret', capability: 'secret.available', subject: 'CLOUDFLARE_API_TOKEN' }];
  const st = status => [{ capability: 'secret.available', subject: 'CLOUDFLARE_API_TOKEN', status }];
  assert.equal(lintAsks([f], phrases, st('present')).length, 1);
  assert.equal(lintAsks([f], phrases, st('unknown')).length, 1);
  assert.equal(lintAsks([f], phrases, st('missing')).length, 0);
  assert.equal(lintAsks([f], phrases, []).length, 0);
});

test('a lint path that does not exist is a failure, not a silent skip', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const cfg = path.join(d, 'a.json'); writeFileSync(cfg, JSON.stringify({ needs: [], lint_paths: ['no-such-dir-xyz'] }));
  const { main } = await import('./cli.mjs'); const old = process.argv; process.argv = ['node', 'cli.mjs', '--config', cfg];
  try { assert.equal(await main(), 1); } finally { process.argv = old; }
});
