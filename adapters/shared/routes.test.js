// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouteTable, safeEqual } from './routes.js';

const req = (p, auth) => new Request('http://h' + p, { headers: auth ? { authorization: auth } : {} });
const rt = env => createRouteTable([{ prefix: '/mcp', tokenEnv: 'MCP_TOKEN', handler: async () => new Response('ok') }, { prefix: '/health', handler: async () => new Response('up') }, { prefix: '/x', handler: async () => { throw new Error('kaboom'); } }], env);

test('prefix match, auth, closed-when-unconfigured, constant-time compare', async () => {
  const t = rt({ MCP_TOKEN: 's3cret' });
  assert.equal(await (await t.dispatch(req('/health'))).text(), 'up');
  assert.equal((await t.dispatch(req('/mcp'))).status, 401);
  assert.equal((await t.dispatch(req('/mcp/x', 'Bearer s3cret'))).status, 200);
  assert.equal((await rt({}).dispatch(req('/mcp', 'Bearer x'))).status, 503);
  assert.equal(await t.dispatch(req('/other')), null);
  assert.ok(safeEqual('a', 'a') && !safeEqual('a', 'ab'));
});
test('a throwing handler becomes a 500 without leaking a stack', async () => {
  const r = await rt({}).dispatch(req('/x')); assert.equal(r.status, 500); assert.ok(!(await r.text()).includes('at '));
});
