// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Ultrastable seed Worker: the server-side heartbeat for one org.
// Cron fires runTick; GET /health shows the last tick's four-line report.
import { runTick } from './tick.js';
import config from './config.js';
import { handleConsole } from './console.js';

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runTick(env.DB, { config, env: presence(env) }));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      const last = await env.DB.prepare(
        `SELECT id, started_at, finished_at, steps_completed, steps_total, report, errors FROM tick_runs ORDER BY id DESC LIMIT 1`
      ).first();
      const ok = Boolean(last && last.steps_completed === last.steps_total);
      return Response.json({ ok, org: config.org_slug, last_tick: last || null }, { status: ok ? 200 : 503 });
    }
    return new Response('ultrastable seed worker\n', { headers: { 'content-type': 'text/plain' } });
  },
};

// The tick sees only whether a secret binding exists, never its value.
function presence(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && v) out[k] = true;
  return out;
}
