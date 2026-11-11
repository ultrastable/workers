// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// MCP tool server (JSON-RPC 2.0) so agent clients can call the org's tools. Two transports share one core, so there is no single route:
// handleRpc(message) for stdio/line transports and handleHttp(request) for HTTP POST. Tools are plain objects:
// { name, description, inputSchema, run(args, ctx) }. Tool errors are returned as isError results, never thrown to the client.
export function createMcpServer({ tools = [], info = { name: 'ultrastable-tools', version: '1.0.0' }, ctx = {} } = {}) {
  const byName = new Map(tools.map(t => [t.name, t]));
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  async function handleRpc(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg?.id ?? null, -32600, 'invalid request');
    if (msg.id === undefined) return null;                                  // notification: no reply
    switch (msg.method) {
      case 'initialize': return ok(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: info });
      case 'ping': return ok(msg.id, {});
      case 'tools/list': return ok(msg.id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema: inputSchema || { type: 'object', properties: {} } })) });
      case 'tools/call': {
        const t = byName.get(msg.params?.name);
        if (!t) return err(msg.id, -32602, 'unknown tool: ' + String(msg.params?.name).slice(0, 60));
        try {
          const out = await t.run(msg.params.arguments || {}, ctx);
          return ok(msg.id, { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] });
        } catch (e) { return ok(msg.id, { isError: true, content: [{ type: 'text', text: String(e?.message || e).slice(0, 300) }] }); }
      }
      default: return err(msg.id, -32601, 'method not found');
    }
  }
  async function handleHttp(request) {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    let body; try { body = await request.json(); } catch { return Response.json(err(null, -32700, 'parse error'), { status: 400 }); }
    const rs = Array.isArray(body) ? (await Promise.all(body.map(handleRpc))).filter(Boolean) : await handleRpc(body);
    return rs === null || (Array.isArray(rs) && !rs.length) ? new Response(null, { status: 202 }) : Response.json(rs);
  }
  /** stdio transport: feed one line of text, get one line back (or '' for a notification). */
  async function handleLine(line) { let m; try { m = JSON.parse(line); } catch { return JSON.stringify(err(null, -32700, 'parse error')); } const r = await handleRpc(m); return r ? JSON.stringify(r) : ''; }
  return { handleRpc, handleHttp, handleLine };
}

/** Generic read tools over the org database: list_items, get_item, claim_status. Writes go through claims/console, not here. */
export const readTools = db => [
  { name: 'list_items', description: 'List work items, optionally by status.', inputSchema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number' } } },
    run: async ({ status, limit = 20 }) => (await (status ? db.prepare('SELECT id,title,status,owner_role FROM items WHERE status = ? ORDER BY priority LIMIT ?').bind(status, Math.min(+limit || 20, 100)) : db.prepare('SELECT id,title,status,owner_role FROM items ORDER BY priority LIMIT ?').bind(Math.min(+limit || 20, 100))).all()).results },
  { name: 'get_item', description: 'One item by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: async ({ id }) => { const r = await db.prepare('SELECT * FROM items WHERE id = ?').bind(String(id)).first(); if (!r) throw new Error('not found'); return r; } },
];
