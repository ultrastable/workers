// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The Models port and the Role runtime port of US-SPEC-14 section 3, with an in-process reference runtime.
//  Models: an alias (small, medium, large) resolves to an endpoint that returns a completion and token counts. The endpoint is
//    a function handed in by the adapter (an edge inference binding, a hosted model, core/router): this module calls no platform.
//    deployCheck() fails when the reviewer and the doer resolve to one model family while two are available (US-14-R10).
//  Role runtime: one instance per role row. An instance runs one piece of work at a time, held by a lease in the store so two
//    runtimes (two processes, two regions) cannot both run the same role. Container jobs, Durable Objects or an agent engine
//    implement the same three calls (instances, runRole, runDispatches) and are adapters.
// Ports: db, now, env (presence map: names to booleans, never values, US-14-R04), config.
export const ALIASES = ['small', 'medium', 'large'];
const stamp = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/** config: { aliases: { small: { endpoint, model, family, key_env? }, ... }, roles: { doer: 'medium', reviewer: 'large' } }
 *  endpoints: { name: async ({ model, messages, max_tokens }) => ({ text, tokens_in, tokens_out }) } */
export function createModelPort({ config = {}, endpoints = {}, env = {} } = {}) {
  const aliases = config.aliases || {};
  const roles = { doer: 'medium', reviewer: 'large', ...(config.roles || {}) };
  const usable = a => !!a && typeof endpoints[a.endpoint] === 'function' && (!a.key_env || env[a.key_env] === true);

  function resolve(alias) {
    const a = aliases[alias];
    if (!a) return { ok: false, error: `unknown alias: ${alias}` };
    if (!a.model || !a.family || !a.endpoint) return { ok: false, error: `alias ${alias} must name an endpoint, a model and a family` };
    if (typeof endpoints[a.endpoint] !== 'function') return { ok: false, error: `alias ${alias}: no endpoint named ${a.endpoint}` };
    if (a.key_env && env[a.key_env] !== true) return { ok: false, error: `alias ${alias}: the setting ${a.key_env} is not present` };
    return { ok: true, alias, endpoint: a.endpoint, model: a.model, family: a.family };
  }

  /** Call the endpoint behind an alias. The result always carries token counts; an endpoint that returns none is an error. */
  async function complete(alias, { messages = [], max_tokens } = {}) {
    const r = resolve(alias);
    if (!r.ok) return r;
    let out;
    try { out = await endpoints[r.endpoint]({ model: r.model, messages, max_tokens }); } catch (e) { return { ok: false, error: `endpoint failed: ${String(e?.message || e).slice(0, 160)}`, alias, model: r.model, family: r.family }; }
    const tin = Number(out?.tokens_in); const tout = Number(out?.tokens_out);
    if (typeof out?.text !== 'string' || !Number.isFinite(tin) || !Number.isFinite(tout) || tin < 0 || tout < 0) return { ok: false, error: 'endpoint must return a completion and token counts', alias, model: r.model, family: r.family };
    return { ok: true, text: out.text, tokens_in: tin, tokens_out: tout, alias, model: r.model, family: r.family };
  }

  /** The deploy-time check. Errors: an alias that does not resolve, a role naming no alias, and reviewer and doer on one
   *  family when the configuration offers two usable families (US-14-R10). With one family only, it passes with a warning. */
  function deployCheck() {
    const errors = []; const warnings = [];
    for (const name of Object.keys(aliases)) { const r = resolve(name); if (!r.ok) errors.push(r.error); }
    for (const role of ['doer', 'reviewer']) if (!aliases[roles[role]]) errors.push(`role ${role} names alias ${roles[role]}, which is not configured`);
    const families = [...new Set(Object.values(aliases).filter(usable).map(a => a.family))].sort();
    const d = aliases[roles.doer]; const v = aliases[roles.reviewer];
    if (d && v && d.family === v.family) {
      if (families.length >= 2) errors.push(`reviewer and doer both resolve to family ${d.family} while ${families.length} families are available (${families.join(', ')}): point the reviewer at another family`);
      else warnings.push(`only one model family is available (${d.family}): the reviewer cannot be independent of the doer`);
    }
    return { ok: errors.length === 0, errors, warnings, families, doer: d ? { alias: roles.doer, family: d.family } : null, reviewer: v ? { alias: roles.reviewer, family: v.family } : null };
  }

  return { resolve, complete, deployCheck, roles };
}

/** handlers: { <role name>: async ({ role, item, complete }) => ({ ok, detail }) }, with `default` as the fallback.
 *  config: { holder (this runtime's name), lease_minutes, default_alias } */
export function createRoleRuntime({ db, models, handlers = {}, now = () => Date.now(), config = {} } = {}) {
  const clock = typeof now === 'function' ? now : () => now;
  const cfg = { holder: 'runtime-1', lease_minutes: 15, default_alias: 'small', ...config };
  const all = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
  const one = (sql, ...a) => db.prepare(sql).bind(...a).first();
  const run = (sql, ...a) => db.prepare(sql).bind(...a).run();

  /** One instance per role row, created on first sight. */
  async function instances() {
    await run(`INSERT OR IGNORE INTO modelport_instances (role_id) SELECT id FROM roles`);
    return all(`SELECT r.id AS role_id, r.role, r.project, r.model, m.holder, m.lease_until, m.runs, m.last_run_at FROM roles r JOIN modelport_instances m ON m.role_id = r.id ORDER BY r.id`);
  }

  async function acquire(roleId) {
    const t = stamp(clock());
    await run(`INSERT OR IGNORE INTO modelport_instances (role_id) VALUES (?)`, roleId);
    const r = await run(`UPDATE modelport_instances SET holder=?, lease_until=? WHERE role_id=? AND (lease_until IS NULL OR lease_until <= ?)`, cfg.holder, stamp(clock() + cfg.lease_minutes * 60e3), roleId, t);
    return (r.meta?.changes ?? 0) === 1;
  }
  const release = roleId => run(`UPDATE modelport_instances SET holder=NULL, lease_until=NULL, runs=runs+1, last_run_at=? WHERE role_id=? AND holder=?`, stamp(clock()), roleId, cfg.holder);

  /** Run one piece of work on a role's instance. Refused with `busy` while the instance is held (here or by another runtime). */
  async function runRole(roleId, { item = null } = {}) {
    const role = await one(`SELECT id, role, project, model FROM roles WHERE id=?`, roleId);
    if (!role) return { ok: false, error: 'no such role' };
    const handler = handlers[role.role] || handlers.default;
    if (typeof handler !== 'function') return { ok: false, error: `no handler for role ${role.role}` };
    if (!(await acquire(roleId))) return { ok: false, busy: true, error: 'this role instance is already running' };
    const alias = ALIASES.includes(role.model) ? role.model : cfg.default_alias;
    const used = { tokens_in: 0, tokens_out: 0, model: null, family: null };
    const complete = async (req, { alias: a = alias } = {}) => {
      const r = await models.complete(a, req);
      if (r.ok) { used.tokens_in += r.tokens_in; used.tokens_out += r.tokens_out; }
      used.model = r.model ?? used.model; used.family = r.family ?? used.family;
      return r;
    };
    let out;
    try { out = await handler({ role, item, complete }); } catch (e) { out = { ok: false, detail: `handler failed: ${String(e?.message || e).slice(0, 200)}` }; }
    const ok = !!out?.ok;
    await run(`INSERT INTO modelport_runs (role_id, item_id, alias, model, family, tokens_in, tokens_out, status, detail, at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      roleId, item?.id ?? null, alias, used.model, used.family, used.tokens_in, used.tokens_out, ok ? 'done' : 'failed', String(out?.detail ?? '').slice(0, 300) || null, stamp(clock()));
    await release(roleId);
    return { ok, detail: out?.detail ?? null, alias, ...used };
  }

  /** Work the queued dispatch rows: each goes to its role's instance. Roles run side by side; one role's dispatches run in order. */
  async function runDispatches({ limit = 20 } = {}) {
    const queued = await all(`SELECT d.id, d.role_id, d.item_id FROM dispatches d WHERE d.status='queued' ORDER BY d.id LIMIT ?`, limit);
    const byRole = new Map();
    for (const d of queued) byRole.set(d.role_id, [...(byRole.get(d.role_id) || []), d]);
    const count = { done: 0, failed: 0, busy: 0 };
    await Promise.all([...byRole.values()].map(async list => {
      for (const d of list) {
        await run(`UPDATE dispatches SET status='running' WHERE id=? AND status='queued'`, d.id);
        const item = await one(`SELECT * FROM items WHERE id=?`, d.item_id);
        const r = await runRole(d.role_id, { item });
        if (r.busy) { await run(`UPDATE dispatches SET status='queued' WHERE id=?`, d.id); count.busy++; continue; }
        await run(`UPDATE dispatches SET status=? WHERE id=?`, r.ok ? 'done' : 'failed', d.id);
        count[r.ok ? 'done' : 'failed']++;
      }
    }));
    return count;
  }

  return { instances, runRole, runDispatches, config: cfg };
}
