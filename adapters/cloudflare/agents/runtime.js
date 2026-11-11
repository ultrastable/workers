// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Agent runtime: a bounded conversation loop over the model router with database-backed memory. It does NOT vendor or
// depend on any agent SDK: an SDK-hosted agent (a Durable Object, for example) can wrap turn() as its handler, and the
// same turn() runs on any host with a D1-shaped db, so there is no single route. A model reply that is exactly one JSON object
// {"tool": name, "args": {...}} calls a registered tool; anything else is the final answer. Tool errors go back to the model.
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
export function createAgentRuntime({ db, router, tools = {}, now = () => Date.now(), config = {} }) {
  const maxSteps = config.max_steps ?? 4, maxHistory = config.max_history ?? 20, rung = config.rung ?? 'medium';
  const save = (sid, role, content) => db.prepare('INSERT INTO agents_messages (session_id, role, content, at) VALUES (?,?,?,?)').bind(sid, role, String(content).slice(0, 8000), iso(now())).run();
  const system = () => (config.system || 'You are an agent in an organization.') + (Object.keys(tools).length ? '\nTools: ' + Object.keys(tools).join(', ') + '. To call one, reply with only {"tool":"name","args":{}}.' : '');
  const parseCall = t => { try { const o = JSON.parse(String(t).trim()); return o && typeof o.tool === 'string' ? o : null; } catch { return null; } };

  async function turn(sessionId, text) {
    await save(sessionId, 'user', text);
    for (let step = 0; step < maxSteps; step++) {
      const hist = (await db.prepare('SELECT role, content FROM (SELECT id, role, content FROM agents_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id').bind(sessionId, maxHistory).all()).results;
      const r = await router.call({ role: 'agent', kind: 'agent', rung, messages: [{ role: 'system', content: system() }, ...hist] });
      if (!r.ok) return { ok: false, refusal: r.refusal, steps: step };
      const call = parseCall(r.text);
      await save(sessionId, 'assistant', r.text);
      if (!call) return { ok: true, text: r.text, steps: step + 1 };
      let result;
      const tool = Object.hasOwn(tools, call.tool) ? tools[call.tool] : null;
      try { result = tool ? JSON.stringify(await tool(call.args || {})) : 'error: unknown tool ' + call.tool; } catch (e) { result = 'error: ' + String(e?.message || e).slice(0, 200); }
      await save(sessionId, 'user', 'tool result: ' + result);
    }
    return { ok: false, refusal: 'max_steps', steps: maxSteps };
  }
  return { turn };
}
