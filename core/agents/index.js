// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Agent runtime (US-SPEC-11): named agents, each with a system prompt and a tool set, running turns against the model router.
// A turn alternates model replies and tool results until the model answers in plain text or the step cap is hit. Platform-free:
// the Durable Object / Agents SDK wrapper is an adapter (NOT COVERED until a live account exists, see ops/extraction-unblocked.json).
//  - Tools: { name: { run(args, ctx), approval?: boolean, description? } } or a bare function. Inherited names are never tools.
//  - Approval: a tool with approval: true does not run; the turn stops with { pending_approval: id }. decide(id, true) runs it and
//    returns the result to the session; denial or expiry tells the model so. Approvals expire (approval_ttl_minutes).
//  - Hooks: before(call) may veto by returning a string reason; after(call, result) observes. A throwing hook vetoes (fail closed).
//  - Compaction: long histories are folded into one summary message (router call) so a session stays inside the context budget.
// Ports: db, router.call({ role, kind, rung, messages }) -> { ok, text, refusal }, now() ms, config.
const DEFAULTS = { max_steps: 6, max_history: 30, approval_ttl_minutes: 60, rung: 'medium', compact_over: 40, compact_keep: 10 };
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

export function parseCall(text) {
  const s = String(text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (!s.startsWith('{')) return null;
  try { const o = JSON.parse(s); return o && typeof o.tool === 'string' ? { tool: o.tool, args: o.args && typeof o.args === 'object' ? o.args : {} } : null; } catch { return null; }
}

export function createAgents({ db, router, now = () => Date.now(), config = {}, hooks = {} }) {
  const c = { ...DEFAULTS, ...(config.agents || config) };
  const defs = new Map();
  const all = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
  const first = async (sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
  const run = (sql, ...a) => db.prepare(sql).bind(...a).run();
  const save = (sid, role, content) => run('INSERT INTO agents_messages (session_id, role, content, at) VALUES (?,?,?,?)', sid, role, String(content), iso(now()));
  const toolOf = (def, name) => { if (!Object.hasOwn(def.tools, name)) return null; const t = def.tools[name]; return typeof t === 'function' ? { run: t } : t; };

  function define(name, def) {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(name)) throw new Error('agent name must be lowercase letters, digits and dashes');
    defs.set(name, { system: '', tools: {}, rung: c.rung, ...def });
  }
  const system = def => def.system + (Object.keys(def.tools).length
    ? '\nTo use a tool reply with only JSON: {"tool":"<name>","args":{...}}. Tools: ' + Object.entries(def.tools).map(([n, t]) => n + (t.description ? ' (' + t.description + ')' : '')).join(', ') + '. Otherwise answer in plain text.' : '');

  async function exec(def, sid, call) {
    const tool = toolOf(def, call.tool);
    if (!tool) return 'error: unknown tool ' + call.tool;
    try {
      const veto = hooks.before ? await hooks.before({ agent: def.name, session: sid, ...call }) : null;
      if (typeof veto === 'string' && veto) return 'error: vetoed: ' + veto.slice(0, 200);
    } catch (e) { return 'error: vetoed: hook failed'; }
    let result;
    try { result = JSON.stringify(await tool.run(call.args)); } catch (e) { result = 'error: ' + String(e?.message || e).slice(0, 200); }
    try { if (hooks.after) await hooks.after({ agent: def.name, session: sid, ...call }, result); } catch { /* observers never break a turn */ }
    return result;
  }

  async function loop(name, sid, startStep = 0) {
    const def = defs.get(name); if (!def) return { ok: false, refusal: 'unknown_agent' };
    for (let step = startStep; step < c.max_steps; step++) {
      const hist = (await all('SELECT role, content FROM (SELECT id, role, content FROM agents_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id', sid, c.max_history));
      const r = await router.call({ role: 'agent', kind: 'agent', rung: def.rung, messages: [{ role: 'system', content: system(def) }, ...hist] });
      if (!r.ok) return { ok: false, refusal: r.refusal, steps: step };
      const call = parseCall(r.text);
      await save(sid, 'assistant', r.text);
      if (!call) return { ok: true, text: r.text, steps: step + 1 };
      const tool = toolOf(def, call.tool);
      if (tool?.approval) {
        const t = now();
        const ins = await run('INSERT INTO agents_approvals (session_id, agent, tool, args_json, created_ms, expires_ms) VALUES (?,?,?,?,?,?)', sid, name, call.tool, JSON.stringify(call.args), t, t + c.approval_ttl_minutes * 60000);
        return { ok: true, pending_approval: ins.meta.last_row_id, tool: call.tool, steps: step + 1 };
      }
      await save(sid, 'user', 'tool result: ' + await exec({ ...def, name }, sid, call));
    }
    return { ok: false, refusal: 'max_steps', steps: c.max_steps };
  }

  async function turn(name, sid, text) { await save(sid, 'user', text); return loop(name, sid); }

  /** Decide a pending approval. Approved and unexpired: run the tool, then let the model continue. */
  async function decide(id, approve, by = 'policy') {
    const a = await first('SELECT * FROM agents_approvals WHERE id = ?', id);
    if (!a) return { ok: false, refusal: 'unknown_approval' };
    if (a.status !== 'pending') return { ok: false, refusal: 'already_' + a.status };
    if (now() >= Number(a.expires_ms)) { await expire(); return { ok: false, refusal: 'expired' }; }
    await run('UPDATE agents_approvals SET status=?, decided_by=? WHERE id=?', approve ? 'approved' : 'denied', by, id);
    const def = defs.get(a.agent); if (!def) return { ok: false, refusal: 'unknown_agent' };
    await save(a.session_id, 'user', 'tool result: ' + (approve ? await exec({ ...def, name: a.agent }, a.session_id, { tool: a.tool, args: JSON.parse(a.args_json) }) : 'error: approval denied'));
    return loop(a.agent, a.session_id);
  }

  /** Expire stale approvals and tell each session, so a model is never left waiting. Returns the count. */
  async function expire() {
    const stale = await all("SELECT id, session_id FROM agents_approvals WHERE status='pending' AND expires_ms <= ?", now());
    for (const a of stale) { await run("UPDATE agents_approvals SET status='expired' WHERE id=?", a.id); await save(a.session_id, 'user', 'tool result: error: approval expired'); }
    return stale.length;
  }

  /** Fold all but the newest compact_keep messages into one summary when the session passes compact_over. */
  async function compact(sid) {
    const n = Number((await first('SELECT COUNT(*) n FROM agents_messages WHERE session_id = ?', sid)).n);
    if (n <= c.compact_over) return { compacted: false, messages: n };
    const old = await all('SELECT id, role, content FROM agents_messages WHERE session_id = ? ORDER BY id LIMIT ?', sid, n - c.compact_keep);
    const r = await router.call({ role: 'agent', kind: 'summary', rung: c.rung, messages: [{ role: 'system', content: 'Summarize this conversation in under 200 words, keeping facts, decisions and open tasks.' }, { role: 'user', content: old.map(m => m.role + ': ' + m.content).join('\n').slice(0, 20000) }] });
    if (!r.ok || !String(r.text).trim()) return { compacted: false, messages: n, refusal: r.refusal || 'empty_summary' };
    const last = old[old.length - 1].id;
    await run('DELETE FROM agents_messages WHERE session_id = ? AND id <= ?', sid, last);
    await run('INSERT INTO agents_messages (id, session_id, role, content, at) VALUES (?,?,?,?,?)', last, sid, 'user', 'summary of earlier conversation: ' + String(r.text).trim().slice(0, 2000), iso(now()));
    return { compacted: true, messages: c.compact_keep + 1 };
  }

  return { define, turn, decide, expire, compact, agents: () => [...defs.keys()] };
}
