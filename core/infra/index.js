// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Infra routes (US-SPEC-14): what every host (Worker fetch, Node server, Cloud Run) shares, defined once.
//  - createInfra({ routes, env, db, now, config, checks }) -> { dispatch(request, ctx) }:
//      path-prefix routes with optional method list, bearer auth (token read from env at request time; unset token = closed 503),
//      a fixed-window rate limit per route and caller, a JSON body cap, handler errors turned into 500 without a stack, and the
//      built-in routes GET /health (liveness) and GET /health/deep (every check, plus stale heartbeats).
//  - heartbeat(ctx, name, every_minutes) / staleHeartbeats(ctx): a scheduled job proves it ran; one that is silent for 2x its period is stale.
//  - capRows(rows, max): bound a database result so one query cannot exhaust a response.
//  - secretsPresent(env, names): which named secrets are set, never their values.
// Ports only: db (D1-shaped), now() ms, env (secrets by name), checks: { name: async () => boolean }.
const DEFAULTS = { max_body_bytes: 1048576, rate_window_ms: 60000, rate_limit: 0, max_rows: 500 };

export function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}
export const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });
export const capRows = (rows, max = DEFAULTS.max_rows) => ({ rows: rows.slice(0, max), truncated: rows.length > max, total: rows.length });
export const secretsPresent = (env = {}, names = []) => Object.fromEntries(names.map(n => [n, typeof env[n] === 'string' && env[n].length > 0]));

export async function heartbeat(ctx, name, every_minutes = null) {
  const t = ctx.now();
  await ctx.db.prepare(`INSERT INTO infra_heartbeats (name, last_ms, every_minutes) VALUES (?,?,?)
    ON CONFLICT(name) DO UPDATE SET last_ms=excluded.last_ms, beats=beats+1, every_minutes=COALESCE(excluded.every_minutes, every_minutes)`).bind(name, t, every_minutes).run();
}
export async function staleHeartbeats(ctx) {
  const t = ctx.now(), rows = (await ctx.db.prepare('SELECT name, last_ms, every_minutes FROM infra_heartbeats WHERE every_minutes IS NOT NULL').all()).results || [];
  return rows.filter(r => t - Number(r.last_ms) > 2 * Number(r.every_minutes) * 60000).map(r => ({ name: r.name, silent_minutes: Math.round((t - Number(r.last_ms)) / 60000) }));
}

export function createInfra({ routes = [], env = {}, db, now = () => Date.now(), config = {}, checks = {} }) {
  const c = { ...DEFAULTS, ...(config.infra || config) };
  const sorted = [...routes].sort((a, b) => b.prefix.length - a.prefix.length);
  const builtin = [
    { prefix: '/health/deep', methods: ['GET'], handler: async () => {
      const res = {}; for (const [n, f] of Object.entries(checks)) { try { res[n] = !!(await f()); } catch { res[n] = false; } }
      const stale = db ? await staleHeartbeats({ db, now }) : [];
      const ok = Object.values(res).every(Boolean) && !stale.length;
      return json({ ok, checks: res, stale_heartbeats: stale }, ok ? 200 : 503);
    } },
    { prefix: '/health', methods: ['GET'], handler: async () => json({ ok: true }) },
  ];
  const table = [...sorted, ...builtin].sort((a, b) => b.prefix.length - a.prefix.length);

  async function limited(route, request) {
    if (!c.rate_limit || !db) return false;
    const w = Math.floor(now() / c.rate_window_ms) * c.rate_window_ms;
    const who = (request.headers.get('authorization') || request.headers.get('cf-connecting-ip') || 'anon').slice(-32);
    const key = route.prefix + '|' + who;
    await db.prepare('DELETE FROM infra_rate WHERE window_ms < ?').bind(w).run();
    await db.prepare('INSERT INTO infra_rate (key, window_ms) VALUES (?,?) ON CONFLICT(key, window_ms) DO UPDATE SET n = n + 1').bind(key, w).run();
    const r = await db.prepare('SELECT n FROM infra_rate WHERE key = ? AND window_ms = ?').bind(key, w).first();
    return Number(r.n) > (route.rate_limit ?? c.rate_limit);
  }

  async function dispatch(request, ctx = {}) {
    const path = new URL(request.url).pathname;
    const r = table.find(x => path === x.prefix || path.startsWith(x.prefix.endsWith('/') ? x.prefix : x.prefix + '/'));
    if (!r) return null;
    if (r.methods && !r.methods.includes(request.method)) return json({ error: 'method not allowed' }, 405, { allow: r.methods.join(', ') });
    if (r.tokenEnv) {
      const want = env[r.tokenEnv];
      if (!want) return json({ error: 'route closed: token not configured' }, 503);
      if (!safeEqual((request.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), want)) return json({ error: 'unauthorized' }, 401);
    }
    if (Number(request.headers.get('content-length') || 0) > (r.max_body_bytes ?? c.max_body_bytes)) return json({ error: 'body too large' }, 413);
    if (await limited(r, request)) return json({ error: 'rate limited' }, 429, { 'retry-after': String(Math.ceil(c.rate_window_ms / 1000)) });
    try { return await r.handler(request, ctx); } catch (e) { return json({ error: 'handler failed', detail: String(e?.message || e).slice(0, 200) }, 500); }
  }
  return { dispatch, list: () => table.map(r => ({ prefix: r.prefix, auth: !!r.tokenEnv, methods: r.methods || 'any' })) };
}
