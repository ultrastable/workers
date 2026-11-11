// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Shared route table (the "infra" of one org): one place that maps path prefixes to handlers and applies bearer-token auth,
// used by every host (Worker fetch, Node server, Cloud Run) so a route is defined once. Ports only: handlers take (request, ctx).
export function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}
export const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

/** routes: [{ prefix, handler, tokenEnv? }]. A route with tokenEnv requires "Authorization: Bearer <env[tokenEnv]>"; unset token = closed (503). */
export function createRouteTable(routes, env = {}) {
  const sorted = [...routes].sort((a, b) => b.prefix.length - a.prefix.length);
  return {
    list: () => sorted.map(r => ({ prefix: r.prefix, auth: !!r.tokenEnv })),
    async dispatch(request, ctx = {}) {
      const path = new URL(request.url).pathname;
      const r = sorted.find(x => path === x.prefix || path.startsWith(x.prefix.endsWith('/') ? x.prefix : x.prefix + '/'));
      if (!r) return null;
      if (r.tokenEnv) {
        const want = env[r.tokenEnv];
        if (!want) return json({ error: 'route closed: token not configured' }, 503);
        const got = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        if (!safeEqual(got, want)) return json({ error: 'unauthorized' }, 401);
      }
      try { return await r.handler(request, ctx); } catch (e) { return json({ error: 'handler failed', detail: String(e?.message || e).slice(0, 200) }, 500); }
    },
  };
}
