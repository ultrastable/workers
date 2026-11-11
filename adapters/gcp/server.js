// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Ultrastable GCP adapter: the same tick as the Cloudflare Worker, served from Cloud Run.
// Cloud Scheduler calls POST /tick on the cron; GET /health reports the last tick.
// Store: SQLite file on a mounted volume (Cloud Storage FUSE or Filestore) today; Cloud SQL (Postgres) is the planned scale-out (see docs/architecture.md).
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { runTick } from '../../core/src/tick.js';
import { openDb } from '../sqlite/d1-sqlite.js';
import { handleConsole } from '../../core/src/console.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = process.env.ULTRASTABLE_MIGRATIONS || path.join(HERE, '../../core/migrations');

export function loadConfig(env = process.env) {
  if (env.ULTRASTABLE_CONFIG) return JSON.parse(readFileSync(env.ULTRASTABLE_CONFIG, 'utf8'));
  const policy = JSON.parse(readFileSync(path.join(HERE, '../../autonomy/policy.json'), 'utf8'));
  return { org_slug: env.ULTRASTABLE_ORG || 'demo', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy };
}

function presence(env) { // the tick learns only that a secret exists, never its value
  const out = {};
  for (const [k, v] of Object.entries(env)) if (/^(GITHUB|ANTHROPIC|CLOUDFLARE|CHAT)_/.test(k) && v) out[k] = true;
  return out;
}

function authorized(req, token) {
  if (!token) return false; // no token configured: refuse, never run open
  const given = Buffer.from(req.headers['x-tick-token'] || ''); // not Authorization: Cloud Scheduler OIDC uses that header
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function createServer({ db, config, env = process.env, now = () => Date.now() }) {
  return http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      if (req.url === '/health') {
        const last = await db.prepare(`SELECT id, started_at, finished_at, steps_completed, steps_total, report, errors FROM tick_runs ORDER BY id DESC LIMIT 1`).first();
        const ok = Boolean(last && last.steps_completed === last.steps_total);
        return send(ok ? 200 : 503, { ok, org: config.org_slug, last_tick: last });
      }
      if (req.url === '/tick' && req.method === 'POST') {
        if (!authorized(req, env.TICK_TOKEN)) return send(401, { error: 'unauthorized' });
        const r = await runTick(db, { config, env: presence(env), now: now() });
        return send(200, r);
      }
      if (req.url.startsWith('/console') || req.url.startsWith('/api/console')) { // the same guided console as the Worker, over the same store handle
        const chunks = []; for await (const c of req) chunks.push(c);
        const base = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
        const r = new Request(base + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), redirect: 'manual' });
        const out = await handleConsole(r, { DB: db, CONSOLE_TOKEN: env.CONSOLE_TOKEN }, { org: config.org_slug });
        const headers = {}; out.headers.forEach((v, k) => { headers[k] = v; });
        res.writeHead(out.status, headers); return res.end(Buffer.from(await out.arrayBuffer()));
      }
      send(404, { error: 'not found' });
    } catch (e) { send(500, { error: e.message }); }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb(process.env.ULTRASTABLE_DB || '/data/ultrastable.db', MIGRATIONS);
  createServer({ db, config: loadConfig() }).listen(Number(process.env.PORT || 8080));
}
