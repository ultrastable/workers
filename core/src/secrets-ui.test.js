// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Connect screen back end (issue #88, epic #84): paste once, stored in the vault, presence only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createVault } from '../vault/index.js';
import { handleConsole } from './console.js';
import { listConnections, saveSecret, removeSecret, routerConnections } from './secrets-ui.js';

const dir = p => fileURLToPath(new URL(p, import.meta.url));
const U = 'https://x.example';
const SECRET = 'sk-test-VALUE-1234567890';
const setup = () => { const db = makeDb([dir('../vault/migrations/'), dir('../doors/migrations/')]); return { db, vault: createVault({ db }) }; };
const router = { providers: { edge: { kind: 'workers_ai', key_env: null }, paid: { kind: 'openai', key_env: 'OPENAI_API_KEY' }, odd: { kind: 'openai', key_env: 'NOT_ALLOWED_NAME' } } };

test('routerConnections names paid providers only; the keyless Workers AI provider asks for nothing', () => {
  assert.deepEqual(routerConnections(router).map(c => c.name), ['OPENAI_API_KEY', 'NOT_ALLOWED_NAME']);
  assert.deepEqual(routerConnections({}), []);
});

test('listConnections: presence and source only, router keys added, names off the allowlist dropped', async () => {
  const { vault } = setup();
  await saveSecret(vault, { name: 'VCS_TOKEN', value: SECRET });
  const list = await listConnections(vault, { ANTHROPIC_API_KEY: true, VCS_TOKEN: true }, { router });
  const by = Object.fromEntries(list.map(c => [c.name, c]));
  assert.deepEqual(Object.keys(by).sort(), ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VCS_TOKEN']);
  assert.equal(by.VCS_TOKEN.source, 'console'); assert.ok(by.VCS_TOKEN.set_at);
  assert.equal(by.ANTHROPIC_API_KEY.source, 'environment'); assert.equal(by.ANTHROPIC_API_KEY.set_at, null);
  assert.equal(by.OPENAI_API_KEY.present, false); assert.equal(by.OPENAI_API_KEY.source, null);
  assert.ok(!JSON.stringify(list).includes(SECRET));
  assert.deepEqual(await listConnections(null), []);
});

test('saveSecret and removeSecret: no value in any reply, bad input refused, env secrets are not removable', async () => {
  const { vault } = setup();
  const ok = await saveSecret(vault, { name: 'ANTHROPIC_API_KEY', value: SECRET });
  assert.deepEqual(ok, { status: 200, body: { name: 'ANTHROPIC_API_KEY', stored: true } });
  for (const bad of [{ name: 'EVIL', value: SECRET }, { name: 'VCS_TOKEN', value: 'short' }]) {
    const r = await saveSecret(vault, bad);
    assert.equal(r.status, 400); assert.ok(!JSON.stringify(r).includes(SECRET));
  }
  assert.equal((await saveSecret(null, {})).status, 503);
  assert.equal((await removeSecret(vault, { name: 'VCS_TOKEN' })).status, 404);
  assert.equal((await removeSecret(vault, { name: 'EVIL' })).status, 400);
  assert.deepEqual((await removeSecret(vault, { name: 'ANTHROPIC_API_KEY' })).body, { name: 'ANTHROPIC_API_KEY', removed: true });
  assert.equal(await vault.has('ANTHROPIC_API_KEY'), false);
});

test('console routes: save, show presence, remove; cross-origin and signed-out are refused; the value never appears', async () => {
  const { db, vault } = setup();
  const env = { DB: db, CONSOLE_TOKEN: 'console-token-1234' };
  const o = { vault, config: { router }, now: () => 0 };
  const cookie = 'us_console=' + encodeURIComponent(env.CONSOLE_TOKEN);
  const post = (path, body, { origin = U, c = cookie } = {}) => new Request(U + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(c ? { cookie: c } : {}) }, body: JSON.stringify(body) });
  assert.equal((await handleConsole(post('/api/console/secret', { name: 'OPENAI_API_KEY', value: SECRET }, { c: null }), env, o)).status, 401);
  assert.equal((await handleConsole(post('/api/console/secret', { name: 'OPENAI_API_KEY', value: SECRET }, { origin: 'https://evil.example' }), env, o)).status, 403);
  const saved = await handleConsole(post('/api/console/secret', { name: 'OPENAI_API_KEY', value: SECRET }), env, o);
  assert.equal(saved.status, 200); assert.ok(!(await saved.text()).includes(SECRET));
  const view = await (await handleConsole(new Request(U + '/api/console', { headers: { cookie } }), env, o)).text();
  assert.ok(!view.includes(SECRET));
  assert.equal(JSON.parse(view).connections.find(c => c.name === 'OPENAI_API_KEY').present, true);
  const gone = await handleConsole(post('/api/console/secret/remove', { name: 'OPENAI_API_KEY' }), env, o);
  assert.equal(gone.status, 200);
  const view2 = JSON.parse(await (await handleConsole(new Request(U + '/api/console', { headers: { cookie } }), env, o)).text());
  assert.equal(view2.connections.find(c => c.name === 'OPENAI_API_KEY').present, false);
});
