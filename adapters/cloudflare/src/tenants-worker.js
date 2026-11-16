// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Worker entry for the tenant store (US-SPEC-25). Every route except /health needs the bearer token. /selftest touches only a
// throwaway tenant with a tiny budget.
//   POST /t/<tenant>/query      { sql, params }
//   POST /t/<tenant>/vec/upsert { id, vector, ns, meta }   POST /t/<tenant>/vec/query { vector, k, ns }
//   POST /t/<tenant>/rollup     { name, key, n, sum, val } GET /t/<tenant>/status
import { DurableObject } from 'cloudflare:workers';
import { makeTenantDO, tenantStub } from './tenant-do.js';
export const TenantDO = makeTenantDO(DurableObject);

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const authed = (req, env) => env.TENANT_TOKEN && req.headers.get('authorization') === 'Bearer ' + env.TENANT_TOKEN;
const out = (r) => (r.ok ? json(r.value) : json(r.error, r.error.code === 'budget_exceeded' ? 429 : 400));

async function selftest(env) {
  const stub = env.TENANT.get(env.TENANT.idFromName('selftest'));
  const t = 'selftest', steps = [];
  const step = (name, ok, detail) => steps.push({ name, ok, detail });
  let r = await stub.query(t, 'CREATE TABLE IF NOT EXISTS probe(k INTEGER PRIMARY KEY, v INTEGER)'); step('create', r.ok);
  r = await stub.query(t, 'INSERT OR REPLACE INTO probe VALUES(1, 41)'); step('write', r.ok && r.value.rowsWritten >= 1);
  r = await stub.query(t, 'SELECT v FROM probe WHERE k=1'); step('indexed read', r.ok && r.value.rows[0].v === 41, r.value && r.value.rowsRead);
  r = await stub.rollupAdd(t, 'probe', 'k'); const g = await stub.rollupGet(t, 'probe', 'k'); step('rollup', r.ok && g.ok && g.value.n >= 1);
  await stub.vectorUpsert(t, 'a', [1, 0, 0], { ns: 'p' }); await stub.vectorUpsert(t, 'b', [0, 1, 0], { ns: 'p' });
  r = await stub.vectorQuery(t, [0.9, 0.1, 0], { k: 1, ns: 'p' }); step('vector', r.ok && r.value[0].id === 'a');
  r = await stub.status(t); step('metered', r.ok && r.value.month.requests > 0, r.ok && { reads: r.value.month.reads, writes: r.value.month.writes });
  return { ok: steps.every(s => s.ok), steps };
}

async function health(env) {
  const stub = env.TENANT.get(env.TENANT.idFromName('selftest'));
  let last = await stub.rollupGet('selftest', 'selftest', 'last');
  if (!last.ok || !last.value || Date.now() - Date.parse(last.value.last_at) > 3600_000) {
    const r = await selftest(env), v = r.ok ? 'pass' : 'fail:' + r.steps.filter(x => !x.ok).map(x => x.name).join(',');
    await stub.rollupAdd('selftest', 'selftest', 'last', { val: v }); await stub.rollupAdd('selftest', 'selftest', r.ok ? 'passes' : 'failures');
    last = await stub.rollupGet('selftest', 'selftest', 'last');
  }
  return { ok: !!(last.ok && last.value && last.value.last_val === 'pass'), service: 'ultrastable-tenants', selftest: last.ok && last.value ? { result: last.value.last_val, at: last.value.last_at } : null };
}

export default {
  async scheduled(_e, env) { await health(env); },
  async fetch(req, env) {
    try { return await route(req, env); } catch (e) { return json({ code: 'internal', message: String(e && e.message || e).slice(0, 300) }, 500); }
  },
};

async function route(req, env) {
    const url = new URL(req.url), path = url.pathname;
    if (path === '/health') return json(await health(env));
    if (!authed(req, env)) return json({ code: 'unauthorized' }, 401);
    if (path === '/selftest') return json(await selftest(env));
    const m = /^\/t\/([a-z0-9-]+)\/(query|vec\/upsert|vec\/query|rollup|status)$/.exec(path);
    if (!m) return json({ code: 'not_found' }, 404);
    let stub; try { stub = tenantStub(env, m[1]); } catch { return json({ code: 'bad_tenant_id' }, 400); }
    const b = req.method === 'POST' ? await req.json() : {};
    if (m[2] === 'query') return out(await stub.query(m[1], b.sql, b.params || []));
    if (m[2] === 'vec/upsert') return out(await stub.vectorUpsert(m[1], b.id, b.vector, { ns: b.ns, meta: b.meta }));
    if (m[2] === 'vec/query') return out(await stub.vectorQuery(m[1], b.vector, { k: b.k, ns: b.ns }));
    if (m[2] === 'rollup') return out(await stub.rollupAdd(m[1], b.name, b.key, b));
    return out(await stub.status(m[1]));
}
