// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// core/tenancy (US-SPEC-10 s7, US-10-R13): tenant registry, the hourly aggregate a tenant pushes to a control plane that
// has no read path to tenant items, and the daily isolation probe. Ports: ctx = { db, now, config, access } where `access`
// is how one tenant's credentials touch another tenant's canary: localAccess (separate databases, or one shared database
// with the tenant id enforced by scopedStore) or httpAccess (each tenant's own canary route and token). Slugs are data.
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const nowMs = ctx => { const v = typeof ctx.now === 'function' ? ctx.now() : ctx.now; return v instanceof Date ? v.getTime() : Number(v); };
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);
export const LEVELS = { 1: 'a separate account per tenant', 2: 'a separate database and worker in a shared account', 3: 'a shared database with the tenant id enforced by policy' };
export const DEFAULT_LEVEL = 2;

/** Register or update a tenant. Idempotent; the first registration time is kept. */
export async function registerTenant(ctx, { slug, level = DEFAULT_LEVEL, runtime = null, bundle_sha256 = null }) {
  if (!SLUG.test(String(slug))) throw new Error('tenancy: slug must be lower-case letters, digits and hyphens, at most 40 characters');
  if (!LEVELS[level]) throw new Error('tenancy: level must be 1, 2 or 3');
  const ts = iso(nowMs(ctx));
  await run(ctx.db, `INSERT INTO tenancy_tenants (slug, level, runtime, bundle_sha256, registered_at, updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(slug) DO UPDATE SET level=excluded.level, runtime=COALESCE(excluded.runtime, runtime), bundle_sha256=COALESCE(excluded.bundle_sha256, bundle_sha256), updated_at=excluded.updated_at`,
    slug, level, runtime, bundle_sha256, ts, ts);
  return first(ctx.db, `SELECT * FROM tenancy_tenants WHERE slug=?`, slug);
}
export const tenants = db => all(db, `SELECT * FROM tenancy_tenants ORDER BY slug`);

/** Level 2 naming: one database and one worker per slug, so two tenants never share a store. */
export const resourceNames = (slug, prefix = 'ultrastable') => { if (!SLUG.test(String(slug))) throw new Error('tenancy: bad slug'); return { database: `${prefix}-${slug}`, worker: `${prefix}-${slug}` }; };

/**
 * Level 3: a store handle bound to one tenant id. Every statement carries the bound id; the caller cannot name another
 * tenant, so a read with tenant B's handle returns zero rows of tenant A.
 */
export function scopedStore(db, tenantId) {
  if (!SLUG.test(String(tenantId))) throw new Error('tenancy: bad tenant id');
  return Object.freeze({
    tenant: tenantId,
    write: (id, body, ts) => run(db, `INSERT OR REPLACE INTO tenancy_canary (id, tenant_id, body, created_at) VALUES (?,?,?,?)`, id, tenantId, body, ts),
    read: id => all(db, `SELECT id, body FROM tenancy_canary WHERE tenant_id=? AND id=?`, tenantId, id),
    remove: async id => (await run(db, `DELETE FROM tenancy_canary WHERE tenant_id=? AND id=?`, tenantId, id)).meta.changes,
  });
}

/** Access port over database handles. `stores`: { slug: db } with one database per tenant (level 2), or one shared db (level 3). */
export function localAccess(stores) {
  const dbOf = slug => { const db = typeof stores === 'function' ? stores(slug) : stores[slug]; if (!db) throw new Error(`tenancy: no store for ${slug}`); return db; };
  return {
    write: (tenant, id, body, ts) => scopedStore(dbOf(tenant), tenant).write(id, body, ts),
    async readAs(reader, owner, id) {
      const mine = dbOf(reader);
      // One shared database: the reader's handle is bound to the reader's tenant id, so the answer is rows (zero when isolated).
      if (mine === dbOf(owner)) return { rows: await scopedStore(mine, reader).read(id) };
      // Separate databases: the reader holds no handle to the owner's store. Look for the owner's row in everything the reader
      // can reach; finding it there is a leak, not finding it is the denial.
      const leaked = await all(mine, `SELECT id, body FROM tenancy_canary WHERE id=?`, id);
      return leaked.length ? { rows: leaked } : { denied: true };
    },
    remove: (tenant, id) => scopedStore(dbOf(tenant), tenant).remove(id),
  };
}

/** Access port over each tenant's own canary route (see `handle`). tenantsCfg: { slug: { url, tokenEnv } }; tokens by name. */
export function httpAccess({ fetch, env = {}, tenants: tenantsCfg }) {
  const call = async (target, credOf, method, id, body) => {
    const t = tenantsCfg[target], c = tenantsCfg[credOf];
    if (!t || !c) throw new Error('tenancy: tenant is not configured for http access');
    const token = env[c.tokenEnv]; if (!token) throw new Error(`tenancy: token variable ${c.tokenEnv} is not set`);
    return fetch(`${String(t.url).replace(/\/$/, '')}/tenancy/canary/${encodeURIComponent(id)}`, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify({ body }) });
  };
  const must = async (res, what) => { if (!res.ok) throw new Error(`tenancy: ${what} -> http ${res.status}`); return res; };
  return {
    write: async (tenant, id, body) => { await must(await call(tenant, tenant, 'PUT', id, body), 'canary write'); },
    async readAs(reader, owner, id) {
      const res = await call(owner, reader, 'GET', id);
      if (res.status === 401 || res.status === 403) return { denied: true, status: res.status };
      if (res.status === 404) return { rows: [] };
      if (!res.ok) throw new Error(`tenancy: canary read -> http ${res.status}`);
      return { rows: (await res.json()).rows || [] };
    },
    remove: async (tenant, id) => { await must(await call(tenant, tenant, 'DELETE', id), 'canary delete'); return 1; },
  };
}

const sameText = (a, b) => { // constant-time comparison of two strings
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i % (y.length || 1)];
  return diff === 0;
};

/**
 * The tenant-side canary route for httpAccess: PUT, GET, DELETE /tenancy/canary/<id>, bearer token compared with the
 * value of env[tokenEnv]. Any other token is refused with 403, no token with 401. Returns null for other paths.
 */
export async function handle(request, { db, env = {}, tokenEnv = 'TENANT_PROBE_TOKEN', slug, now = Date.now() }) {
  const m = /^\/tenancy\/canary\/([\w-]{1,80})$/.exec(new URL(request.url).pathname);
  if (!m) return null;
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const secret = env[tokenEnv], given = /^Bearer (.+)$/.exec(request.headers.get('authorization') || '')?.[1];
  if (!secret) return json({ error: 'probe_not_configured' }, 503);
  if (!given) return json({ error: 'unauthorized' }, 401);
  if (!sameText(given, secret)) return json({ error: 'forbidden' }, 403);
  const store = scopedStore(db, slug), id = m[1];
  if (request.method === 'PUT') { const b = await request.json().catch(() => ({})); await store.write(id, String(b.body ?? ''), iso(typeof now === 'function' ? now() : now)); return json({ ok: true }); }
  if (request.method === 'GET') return json({ rows: await store.read(id) });
  if (request.method === 'DELETE') return json({ deleted: await store.remove(id) });
  return json({ error: 'method_not_allowed' }, 405);
}

/**
 * One isolation probe for the ordered pair (a, b): write a canary in a, read it with b's credentials, expect denial or
 * zero rows, delete the canary, record the result. A mismatch is a severe outcome and a priority-0 item (US-10-R13).
 * The control database (ctx.db) needs the seed `items` table and this module's tables.
 */
export async function isolationProbe(ctx, { a, b, level = DEFAULT_LEVEL }) {
  const now = nowMs(ctx), ts = iso(now), id = `canary-${a}-${b}-${now}`, body = `isolation canary ${ts}`;
  let result = 'unknown', detail = '', deleted = 0, written = false;
  try {
    await ctx.access.write(a, id, body, ts); written = true;
    const r = await ctx.access.readAs(b, a, id);
    if (r?.denied) { result = 'pass'; detail = `denied${r.status ? ' (http ' + r.status + ')' : ''}`; }
    else if (Array.isArray(r?.rows) && r.rows.length === 0) { result = level === 3 ? 'pass' : 'fail'; detail = level === 3 ? 'zero rows' : `tenant ${b}'s credentials were accepted by tenant ${a} (zero rows where a denial is required at level ${level})`; }
    else if (Array.isArray(r?.rows)) { result = 'fail'; detail = `tenant ${b} read ${r.rows.length} row(s) of tenant ${a}`; }
    else { detail = 'the read returned neither a denial nor rows'; }
  } catch (e) { detail = String(e?.message || e).slice(0, 200); }
  if (written) {
    try { deleted = (await ctx.access.remove(a, id)) ? 1 : 0; } catch (e) { detail += `; canary delete failed: ${String(e?.message || e).slice(0, 120)}`; }
  }
  await run(ctx.db, `INSERT INTO tenancy_probes (tenant_a, tenant_b, level, result, severity, detail, canary_deleted, checked_at) VALUES (?,?,?,?,?,?,?,?)`,
    a, b, level, result, result === 'fail' ? 'severe' : null, detail, deleted, ts);
  const itemId = `ISOLATION-${a}-${b}`;
  if (result === 'fail') {
    await run(ctx.db, `INSERT INTO items (id, title, kind, owner_role, done_check, closing_probe, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,0,?,?)
      ON CONFLICT(id) DO UPDATE SET status='open', disposition=NULL, priority=0, title=excluded.title, updated_at=excluded.updated_at`,
      itemId, `SEVERE: tenant isolation breached, ${detail}`.slice(0, 300), 'fix', 'operations', `the isolation probe for ${a} -> ${b} passes`, `tenancy_probes: latest result for (${a}, ${b}) is pass`, ts, ts);
  } else if (result === 'pass') {
    await run(ctx.db, `UPDATE items SET status='done', disposition=?, updated_at=? WHERE id=? AND status NOT IN ('done','superseded','cancelled')`, `isolation probe passed at ${ts}: ${detail}`, ts, itemId);
  }
  if (written && !deleted) {
    await run(ctx.db, `INSERT OR IGNORE INTO items (id, title, kind, owner_role, done_check, closing_probe, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,10,?,?)`,
      `ISOLATION-CANARY-${a}`, `Isolation canary ${id} was not deleted from tenant ${a}`, 'fix', 'operations', 'the canary row is gone', `tenancy canary ${id} absent`, ts, ts);
  }
  return { a, b, level, result, severity: result === 'fail' ? 'severe' : null, detail, canary_deleted: !!deleted };
}

/** Probe every ordered pair of registered tenants that has no probe in the last `probe_every_hours` (default 24). */
export async function isolationSweep(ctx) {
  const every = (ctx.config?.tenancy?.probe_every_hours || 24) * 3600000, now = nowMs(ctx), list = await tenants(ctx.db), out = [];
  for (const ta of list) for (const tb of list) {
    if (ta.slug === tb.slug) continue;
    const last = await first(ctx.db, `SELECT checked_at FROM tenancy_probes WHERE tenant_a=? AND tenant_b=? ORDER BY id DESC LIMIT 1`, ta.slug, tb.slug);
    if (last && now - Date.parse(last.checked_at.replace(' ', 'T') + 'Z') < every) continue;
    out.push(await isolationProbe(ctx, { a: ta.slug, b: tb.slug, level: Math.max(ta.level, tb.level) }));
  }
  return { pairs: list.length * Math.max(0, list.length - 1), probed: out.length, failed: out.filter(r => r.result === 'fail').length, unknown: out.filter(r => r.result === 'unknown').length, results: out };
}

const AGG_KEYS = ['items_open', 'items_done', 'gates_open', 'ticks_last_hour', 'ticks_complete_last_hour', 'predictions_scored'];
/** Tenant side: the hourly aggregate. Counts only; nothing that names or quotes an item leaves the tenant. */
export async function buildAggregate(ctx) {
  const now = nowMs(ctx), hourAgo = iso(now - 3600000), n = async (sql, ...a) => Number((await first(ctx.db, sql, ...a))?.n || 0);
  return {
    hour: iso(now).slice(0, 13),
    items_open: await n(`SELECT COUNT(*) AS n FROM items WHERE status NOT IN ('done','superseded','cancelled')`),
    items_done: await n(`SELECT COUNT(*) AS n FROM items WHERE status='done'`),
    gates_open: await n(`SELECT COUNT(*) AS n FROM gate_cards WHERE status='open'`),
    ticks_last_hour: await n(`SELECT COUNT(*) AS n FROM tick_runs WHERE started_at >= ?`, hourAgo),
    ticks_complete_last_hour: await n(`SELECT COUNT(*) AS n FROM tick_runs WHERE started_at >= ? AND steps_completed = steps_total AND finished_at IS NOT NULL`, hourAgo),
    predictions_scored: await n(`SELECT COUNT(*) AS n FROM outcomes`),
  };
}

/** Control side: accept an aggregate. Anything but the hour and the known counts is refused, so no item can ride along. */
export async function receiveAggregate(ctx, slug, aggregate) {
  if (!(await first(ctx.db, `SELECT slug FROM tenancy_tenants WHERE slug=?`, slug))) return { ok: false, reason: 'unknown_tenant' };
  if (!aggregate || !/^\d{4}-\d{2}-\d{2} \d{2}$/.test(String(aggregate.hour))) return { ok: false, reason: 'bad_hour' };
  const extra = Object.keys(aggregate).filter(k => k !== 'hour' && !AGG_KEYS.includes(k));
  if (extra.length) return { ok: false, reason: 'unknown_field', fields: extra };
  const bad = AGG_KEYS.filter(k => k in aggregate && !(Number.isInteger(aggregate[k]) && aggregate[k] >= 0));
  if (bad.length) return { ok: false, reason: 'not_a_count', fields: bad };
  const payload = JSON.stringify(Object.fromEntries(AGG_KEYS.filter(k => k in aggregate).map(k => [k, aggregate[k]])));
  await run(ctx.db, `INSERT INTO tenancy_aggregates (slug, hour, payload, received_at) VALUES (?,?,?,?) ON CONFLICT(slug, hour) DO UPDATE SET payload=excluded.payload, received_at=excluded.received_at`,
    slug, aggregate.hour, payload, iso(nowMs(ctx)));
  return { ok: true };
}

/** Control side: a tenant whose last aggregate is older than `silent_after_hours` (default 3) is silent; each gets an item. */
export async function silentTenants(ctx) {
  const limit = (ctx.config?.tenancy?.silent_after_hours || 3) * 3600000, now = nowMs(ctx), ts = iso(now), out = [];
  for (const t of await tenants(ctx.db)) {
    const last = await first(ctx.db, `SELECT received_at FROM tenancy_aggregates WHERE slug=? ORDER BY hour DESC LIMIT 1`, t.slug);
    const since = Date.parse((last?.received_at || t.registered_at).replace(' ', 'T') + 'Z'), id = `TENANT-SILENT-${t.slug}`;
    if (now - since > limit) {
      out.push(t.slug);
      await run(ctx.db, `INSERT INTO items (id, title, kind, owner_role, done_check, closing_probe, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,5,?,?)
        ON CONFLICT(id) DO UPDATE SET status='open', disposition=NULL, updated_at=excluded.updated_at WHERE items.status='done'`,
        id, `Tenant ${t.slug} has pushed no aggregate since ${last?.received_at || 'registration'}`, 'fix', 'operations', 'an aggregate arrives from the tenant', `tenancy_aggregates: a row for ${t.slug} within the limit`, ts, ts);
    } else {
      await run(ctx.db, `UPDATE items SET status='done', disposition='aggregate received', updated_at=? WHERE id=? AND status NOT IN ('done','superseded','cancelled')`, ts, id);
    }
  }
  return out;
}

/**
 * Tick steps. Control plane: `tenancy_isolation` (daily per pair) and `tenancy_silent`. Tenant: `tenancy_push` posts the
 * aggregate through ports.push (the host's call to the control plane). Opt-in: config.tenancy.role is 'control' or 'tenant'.
 */
export function tenancySteps(ports = {}) {
  return [{ name: 'tenancy', async run(db, tick) {
    const c = tick.config?.tenancy;
    if (!c?.role) return;
    const ctx = { db, now: tick.now, config: tick.config, access: ports.access };
    if (c.role === 'control') {
      const silent = await silentTenants(ctx);
      const sweep = ports.access ? await isolationSweep(ctx) : { probed: 0, failed: 0 };
      if (sweep.probed || silent.length) tick.notes?.push(`tenancy: ${sweep.probed} isolation probe(s), ${sweep.failed} failed, ${silent.length} silent tenant(s)`);
    } else if (c.role === 'tenant' && ports.push && tick.tickId % (c.push_every_ticks || 6) === 0) {
      await ports.push(await buildAggregate(ctx));
    }
  } }];
}
