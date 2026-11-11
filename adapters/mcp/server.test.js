// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../../core/_shared/testdb.js';
import { createMcpServer, readTools } from './server.js';

const mk = () => { const db = makeDb(); db.raw.exec("INSERT INTO items (id,title,owner_role,done_check) VALUES ('I-1','t','staff','d')"); return createMcpServer({ tools: [...readTools(db), { name: 'boom', run: async () => { throw new Error('bad'); } }] }); };
const call = (s, name, args) => s.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

test('initialize, list, and call over the line transport', async () => {
  const s = mk();
  assert.equal(JSON.parse(await s.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }))).result.serverInfo.name, 'ultrastable-tools');
  assert.equal(await s.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), '');
  const l = await s.handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(l.result.tools.map(t => t.name), ['list_items', 'get_item', 'boom']);
  assert.match((await call(s, 'get_item', { id: 'I-1' })).result.content[0].text, /"I-1"/);
});
test('HTTP transport shares the core; errors are results, unknown tools are rpc errors', async () => {
  const s = mk();
  const r = await s.handleHttp(new Request('http://x/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) }));
  assert.equal((await r.json()).result.tools.length, 3);
  assert.equal((await call(s, 'boom', {})).result.isError, true);
  assert.equal((await call(s, 'nope', {})).error.code, -32602);
  assert.equal((await s.handleHttp(new Request('http://x/mcp', { method: 'GET' }))).status, 405);
  assert.equal((await s.handleHttp(new Request('http://x/mcp', { method: 'POST', body: '{' }))).status, 400);
});
