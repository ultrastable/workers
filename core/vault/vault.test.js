// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../_shared/testdb.js';
import { createVault } from './index.js';
import { fileURLToPath } from 'node:url';

const MIG = fileURLToPath(new URL('./migrations/', import.meta.url));
const SECRET = 'sk-test-0123456789abcdef';

test('a pasted secret is stored; its presence is readable, its value never appears in names()', async () => {
  const v = createVault({ db: makeDb([MIG]) });
  assert.deepEqual(await v.put('ANTHROPIC_API_KEY', SECRET), { name: 'ANTHROPIC_API_KEY', stored: true });
  assert.equal(await v.has('ANTHROPIC_API_KEY'), true);
  const names = await v.names();
  assert.equal(names.length, 1);
  assert.ok(!JSON.stringify(names).includes(SECRET));
});

test('only allowlisted, well-formed names and plausible values are accepted', async () => {
  const v = createVault({ db: makeDb([MIG]) });
  assert.ok((await v.put('rm -rf', SECRET)).error);
  assert.ok((await v.put('SOME_OTHER_NAME', SECRET)).error);
  assert.ok((await v.put('ANTHROPIC_API_KEY', 'short')).error);
  assert.equal(await v.has('ANTHROPIC_API_KEY'), false);
});

test('withVault fills only missing env names; a real env value wins', async () => {
  const v = createVault({ db: makeDb([MIG]) });
  await v.put('ANTHROPIC_API_KEY', SECRET); await v.put('VCS_TOKEN', 'ghp-from-vault-123');
  const env = await v.withVault({ VCS_TOKEN: 'from-env-value' });
  assert.equal(env.ANTHROPIC_API_KEY, SECRET);
  assert.equal(env.VCS_TOKEN, 'from-env-value');
});

test('redact removes stored values from any text; read records last use; remove deletes', async () => {
  const v = createVault({ db: makeDb([MIG]) });
  await v.put('ANTHROPIC_API_KEY', SECRET);
  assert.equal(await v.redact(`call failed with ${SECRET} in header`), 'call failed with [redacted] in header');
  assert.equal(await v.read('ANTHROPIC_API_KEY'), SECRET);
  assert.ok((await v.names())[0].last_used_at);
  await v.remove('ANTHROPIC_API_KEY');
  assert.equal(await v.read('ANTHROPIC_API_KEY'), null);
});

test('replacing a secret updates it in place', async () => {
  const v = createVault({ db: makeDb([MIG]) });
  await v.put('VCS_TOKEN', 'first-token-value'); await v.put('VCS_TOKEN', 'second-token-value');
  assert.equal((await v.names()).length, 1);
  assert.equal(await v.read('VCS_TOKEN'), 'second-token-value');
});
