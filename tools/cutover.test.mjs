// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateInstance, loadInstance } from './instance_config.mjs';
import { runParity } from './parity_smoke.mjs';

const example = () => JSON.parse(readFileSync(new URL('../docs/cutover/instance.example.json', import.meta.url), 'utf8'));
const contract = () => JSON.parse(readFileSync(new URL('../docs/cutover/parity-contract.json', import.meta.url), 'utf8'));

test('example instance validates', () => assert.deepEqual(validateInstance(example()), []));
test('secret values are rejected, binding names pass', () => {
  const c = example(); c.secrets.github = 'ghp_abc123';
  assert.match(validateInstance(c).join(), /binding name/);
});
test('single route is rejected', () => {
  const c = example(); c.routes = [c.routes[0]];
  assert.match(validateInstance(c).join(), /no single route/);
});
test('loader falls back from a bad file to the env route', () => {
  const r = loadInstance({ file: 'x.json', env: { ULTRASTABLE_INSTANCE_JSON: JSON.stringify(example()) }, read: () => { throw new Error('ENOENT'); } });
  assert.equal(r.ok, true); assert.equal(r.via, 'env'); assert.equal(r.tried.length, 1);
});

const fake = (table) => async (url) => {
  const hit = table.find(([prefix]) => url.startsWith(prefix));
  if (!hit) throw new Error('down');
  const [, status, body] = hit;
  return new Response(body, { status });
};
const good = (host) => [[host + '/health', 200, '{}'], [host + '/describe.json', 200, '{"a":1}'], [host + '/llms.txt', 200, 'x'], [host + '/console', 200, '<html>'], [host + '/api/claims', 401, '{}'], [host + '/api/console/items', 401, '{}']];

test('parity passes when both sides conform and agree, using the second route when the first is down', async () => {
  const f = fake([...good('https://old2.test'), ...good('https://new.test')]);
  const r = await runParity({ from: ['https://old1.test', 'https://old2.test'], to: ['https://new.test'], contract: contract(), fetchFn: f });
  assert.equal(r.pass, true);
});
test('parity fails when the new side diverges', async () => {
  const bad = good('https://new.test').map(x => x[0].endsWith('/console') ? [x[0], 500, ''] : x);
  const r = await runParity({ from: ['https://old.test'], to: ['https://new.test'], contract: contract(), fetchFn: fake([...good('https://old.test'), ...bad]) });
  assert.equal(r.pass, false);
  assert.equal(r.rows.find(x => x.id === 'console').pass, false);
});
test('parity fails when no route answers', async () => {
  const r = await runParity({ from: ['https://old.test'], to: ['https://gone.test'], contract: contract(), fetchFn: fake(good('https://old.test')) });
  assert.equal(r.pass, false);
});
