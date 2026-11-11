// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Ultrastable GCP adapter: the same tick as the Cloudflare Worker, served from Cloud Run.
// Cloud Scheduler calls POST /tick on the cron; GET /health reports the last tick.
// Store: SQLite file on a mounted volume (Cloud Storage FUSE or Filestore) today; Cloud SQL (Postgres) is the planned scale-out (see docs/architecture.md).
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { openDb } from '../sqlite/d1-sqlite.js';
import { createOrg } from '../../core/org/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = process.env.ULTRASTABLE_MIGRATIONS || path.join(HERE, '../cloudflare/migrations');

export function loadConfig(env = process.env) {
  if (env.ULTRASTABLE_CONFIG) return JSON.parse(readFileSync(env.ULTRASTABLE_CONFIG, 'utf8'));
  const policy = JSON.parse(readFileSync(path.join(HERE, '../../autonomy/policy.json'), 'utf8'));
  return { org_slug: env.ULTRASTABLE_ORG || 'demo', claim_ttl_minutes: 120, max_wip_per_role: 3, plus_share: 0.2, policy };
}

function authorized(req, token) {
  if (!token) return false; // no token configured: refuse, never run open
  const given = Buffer.from(req.headers['x-tick-token'] || ''); // not Authorization: Cloud Scheduler OIDC uses that header
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

// The store is migrated here too (additive, idempotent), so an older database file gains every module's tables.
function ensureMigrated(db, dir = MIGRATIONS) {
  if (!db.raw?.exec) return;
  for (const f of readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) db.raw.exec(readFileSync(path.join(dir, f), 'utf8'));
}

export function createServer({ db, config, env = process.env, now = () => Date.now(), org: orgOpts = {} }) {
  ensureMigrated(db);
  const org = createOrg({ db, env, config, now, ...orgOpts }); // the same composition root as the Worker
  return http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      if (req.url === '/tick' && req.method === 'POST') {
        if (!authorized(req, env.TICK_TOKEN)) return send(401, { error: 'unauthorized' });
        return send(200, await org.tick());
      }
      const chunks = []; for await (const c of req) chunks.push(c);
      const base = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
      const r = new Request(base + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), redirect: 'manual' });
      const out = await org.handle(r); // /health, /console*, /api/console*, /describe, /describe.json, /llms.txt
      if (!out) return send(404, { error: 'not found' });
      const headers = {}; out.headers.forEach((v, k) => { headers[k] = v; });
      res.writeHead(out.status, headers); return res.end(Buffer.from(await out.arrayBuffer()));
    } catch (e) { send(500, { error: e.message }); }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb(process.env.ULTRASTABLE_DB || '/data/ultrastable.db', MIGRATIONS);
  createServer({ db, config: loadConfig() }).listen(Number(process.env.PORT || 8080));
}
