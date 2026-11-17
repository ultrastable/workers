// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// core/access: the access preflight (owner directive 2026-11-17: never ask the owner for access that already exists).
// - CAPABILITIES: each names the routes that can prove it present. A route answers 'present', 'absent' (authoritative) or
//   'unknown' (could not tell: a 403 from a token that cannot see the thing, a network error). Only a full set of routes with
//   no 'present' and no 'unknown' and at least one 'absent' yields status 'missing'; an unreachable answer is never 'missing'.
// - probe() records every route result; the newest probe is the state.
// - askOwner() is the only way to put an access request in front of the owner: it needs that state, and it writes the permit
//   that the database trigger (migrations/0001_access.sql) demands. Any other gate card about access is closed by the database
//   on insert and becomes a staff item. Rules written in the database cannot be skipped by a module that forgets to call this.
// Ports: ctx = { db, now() -> ms, fetch, env, config: { ttl_minutes?, tokens?: {github: [envNames], cloudflare: [envNames]}, vaultHas? } }.
// Tenant-agnostic: a tenant lists the capabilities it needs in its own config; nothing here names a tenant.
const iso = ctx => new Date(ctx.now()).toISOString();
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
const present = detail => ({ outcome: 'present', detail });
const absent = detail => ({ outcome: 'absent', detail });
const unknown = detail => ({ outcome: 'unknown', detail });

function tokenNames(ctx, provider) {
  const c = ctx.config?.tokens?.[provider];
  if (Array.isArray(c) && c.length) return c;
  return provider === 'github' ? ['GITHUB_TOKEN', 'GH_TOKEN', 'VCS_TOKEN'] : ['CLOUDFLARE_API_TOKEN'];
}
async function api(ctx, provider, path) {
  const base = provider === 'github' ? 'https://api.github.com' : 'https://api.cloudflare.com/client/v4';
  const names = tokenNames(ctx, provider).filter(n => ctx.env?.[n]);
  if (!names.length) return { none: true };
  const tried = [];
  for (const n of names) {
    try {
      const h = { authorization: `Bearer ${ctx.env[n]}`, accept: provider === 'github' ? 'application/vnd.github+json' : 'application/json', 'user-agent': 'ultrastable-access-preflight' };
      const r = await ctx.fetch(base + path, { headers: h });
      let body = null; try { body = await r.json(); } catch { /* not json */ }
      if (r.status >= 200 && r.status < 300) return { status: r.status, body, token: n };
      tried.push(`${n}:${r.status}`);
    } catch (e) { tried.push(`${n}:${String(e && e.message || e).slice(0, 80)}`); }
  }
  return { failed: tried };
}
const cfResult = r => (r.body && (r.body.result ?? r.body)) || [];

/** capability id -> { describe, routes: [{ id, run(ctx, subject) -> { outcome, detail } }] }. Subjects are plain strings. */
export const CAPABILITIES = {
  // subject: '<org>/<app-slug>', e.g. 'ExampleOrg/cloudflare-workers-and-pages'. config.github_sample_repos lists repos whose recent runs are checked.
  'github.app_installed': { describe: 'a GitHub App is installed on an organization', routes: [
    { id: 'org_installations', run: async (ctx, subject) => {
      const [org, slug] = subject.split('/');
      const r = await api(ctx, 'github', `/orgs/${org}/installations?per_page=100`);
      if (r.none) return unknown('no GitHub token in the environment');
      if (r.failed) return unknown(`organization installations not readable: ${r.failed.join(' ')}`);
      const hit = (r.body?.installations || []).find(i => i.app_slug === slug);
      return hit ? present(`installation ${hit.id} on ${org}, repository selection ${hit.repository_selection}`) : absent(`${org} lists ${(r.body?.installations || []).length} installations, none is ${slug}`);
    } },
    { id: 'check_run_author', run: async (ctx, subject) => {
      const [org, slug] = subject.split('/');
      const repos = (ctx.config?.github_sample_repos || []).filter(x => x.startsWith(org + '/'));
      if (!repos.length) return unknown('no sample repositories configured for this organization');
      for (const repo of repos) {
        const c = await api(ctx, 'github', `/repos/${repo}/commits?per_page=5`);
        if (!c.body || !Array.isArray(c.body)) continue;
        for (const commit of c.body) {
          const cr = await api(ctx, 'github', `/repos/${repo}/commits/${commit.sha}/check-runs?per_page=100`);
          if ((cr.body?.check_runs || []).some(x => x.app?.slug === slug)) return present(`${slug} posted a check run on ${repo}@${commit.sha.slice(0, 7)}`);
        }
      }
      return unknown(`no check run by ${slug} on recent commits of ${repos.join(', ')} (it may be installed and silent)`);
    } },
  ] },
  // subject: '<owner>/<repo>:push' or ':read'
  'github.repo_permission': { describe: 'the token can push to or read a repository', routes: [
    { id: 'repo_permissions', run: async (ctx, subject) => {
      const [repo, level] = subject.split(':');
      const r = await api(ctx, 'github', `/repos/${repo}`);
      if (r.none) return unknown('no GitHub token in the environment');
      if (r.failed) return unknown(`repository not readable: ${r.failed.join(' ')}`);
      const p = r.body?.permissions;
      if (!p) return unknown('the token did not report permissions');
      return p[level || 'push'] ? present(`${level || 'push'} granted on ${repo} via ${r.token}`) : absent(`${level || 'push'} not granted on ${repo}`);
    } },
  ] },
  // subject: '<owner>/<repo>:<workflow file>'. Proof by the capability's own use: the workflow has succeeded. A workflow that never
  // succeeded proves nothing about the cause, so that is unknown, never absent.
  'github.workflow_ran_ok': { describe: 'a workflow has run to success', routes: [
    { id: 'last_success', run: async (ctx, subject) => {
      const [repo, wf] = subject.split(':');
      const r = await api(ctx, 'github', `/repos/${repo}/actions/workflows/${wf}/runs?status=success&per_page=1`);
      if (r.none) return unknown('no GitHub token in the environment');
      if (r.failed) return unknown(`workflow runs not readable: ${r.failed.join(' ')}`);
      const run = r.body?.workflow_runs?.[0];
      return run ? present(`${wf} succeeded at ${run.updated_at} (run ${run.id})`) : unknown(`${wf} has no successful run yet`);
    } },
  ] },
  // subject: account id
  'cloudflare.account_access': { describe: 'the Cloudflare credentials reach an account', routes: [
    { id: 'accounts_list', run: async (ctx, subject) => {
      const r = await api(ctx, 'cloudflare', '/accounts?per_page=50');
      if (r.none) return unknown('no Cloudflare token in the environment');
      if (r.failed) return unknown(`accounts not listable: ${r.failed.join(' ')}`);
      const hit = cfResult(r).find?.(a => a.id === subject || a.name === subject);
      return hit ? present(`account ${hit.name} (${hit.id}) is listed via ${r.token}`) : absent(`${cfResult(r).length} accounts listed, none is ${subject}`);
    } },
  ] },
  'cloudflare.workers_deploy': { describe: 'the Cloudflare credentials can read and write Worker scripts in an account', routes: [
    { id: 'scripts_list', run: async (ctx, subject) => {
      const r = await api(ctx, 'cloudflare', `/accounts/${subject}/workers/scripts`);
      if (r.none) return unknown('no Cloudflare token in the environment');
      if (r.failed) return unknown(`scripts not listable: ${r.failed.join(' ')}`);
      return present(`${cfResult(r).length} Worker scripts listed via ${r.token}`);
    } },
  ] },
  // subject: '<account id>/<owner>/<repo>'
  'cloudflare.git_connection': { describe: 'a Cloudflare account has a Git connection to a repository (Workers Builds)', routes: [
    { id: 'builds_triggers', run: async (ctx, subject) => {
      const [acct, owner, repo] = subject.split('/'); const want = `${owner}/${repo}`.toLowerCase();
      const list = await api(ctx, 'cloudflare', `/accounts/${acct}/workers/scripts`);
      if (list.none) return unknown('no Cloudflare token in the environment');
      if (list.failed) return unknown(`scripts not listable: ${list.failed.join(' ')}`);
      const scripts = cfResult(list);
      if (scripts.length > 100) return unknown('more than 100 scripts: scan not exhaustive');
      for (const s of scripts) {
        const t = await api(ctx, 'cloudflare', `/accounts/${acct}/builds/workers/${s.tag || s.id}/triggers`);
        if (t.failed || t.none) return unknown(`triggers of ${s.id} not readable`);
        const hit = cfResult(t).find?.(x => String(x.repo_connection?.repo_name || '').toLowerCase() === repo.toLowerCase() && String(x.repo_connection?.provider_account_name || owner).toLowerCase() === owner.toLowerCase());
        if (hit) return present(`Worker ${s.id} builds from ${want}`);
      }
      return absent(`${scripts.length} Worker scripts scanned, none has a build trigger from ${want}`);
    } },
  ] },
  // subject: a dotted path in the platform's own configuration (ctx.settings). Nothing outside the configuration can supply it.
  'config.setting': { describe: 'a configuration value is set', routes: [
    { id: 'config_path', run: async (ctx, subject) => {
      if (!ctx.settings || typeof ctx.settings !== 'object') return unknown('no configuration object given');
      const v = subject.replace(/^config\./, '').split('.').reduce((o, k) => (o == null ? o : o[k]), ctx.settings);
      return v === undefined || v === null || v === '' ? absent(`${subject} is not set`) : present(`${subject} is set`);
    } },
  ] },
  // subject: an environment variable or vault secret name. Names only, never values.
  'secret.available': { describe: 'a secret is available to the platform', routes: [
    { id: 'environment', run: async (ctx, subject) => (ctx.env?.[subject] ? present('set in the environment') : absent('not set in the environment')) },
    { id: 'vault', run: async (ctx, subject) => {
      if (typeof ctx.config?.vaultHas !== 'function') return unknown('no vault reader configured');
      try { return (await ctx.config.vaultHas(subject)) ? present('held by the vault') : absent('not in the vault'); } catch (e) { return unknown(`vault unreadable: ${String(e && e.message || e).slice(0, 80)}`); }
    } },
  ] },
};

/** Probe one capability: run every route, record each, store the state. Returns the state. */
export async function probe(ctx, capability, subject, { registry = CAPABILITIES } = {}) {
  const def = registry[capability];
  if (!def) throw new Error(`access: unknown capability ${capability}`);
  const at = iso(ctx), ttl = (ctx.config?.ttl_minutes ?? 360) * 60000, pid = globalThis.crypto.randomUUID();
  const results = [];
  for (const r of def.routes) {
    let o; try { o = await r.run(ctx, subject); } catch (e) { o = unknown(`route threw: ${String(e && e.message || e).slice(0, 120)}`); }
    results.push({ route: r.id, ...o });
    await run(ctx.db, `INSERT INTO access_routes (capability, subject, route, outcome, detail, at, probe_id) VALUES (?,?,?,?,?,?,?)`, capability, subject, r.id, o.outcome, String(o.detail).slice(0, 400), at, pid);
  }
  const status = results.some(x => x.outcome === 'present') ? 'present'
    : results.some(x => x.outcome === 'unknown') || !results.some(x => x.outcome === 'absent') ? 'unknown' : 'missing';
  const evidence = JSON.stringify(results.map(x => ({ route: x.route, outcome: x.outcome, detail: x.detail })));
  await run(ctx.db, `INSERT INTO access_state (capability, subject, status, probe_id, checked_at, expires_at, evidence) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(capability, subject) DO UPDATE SET status = excluded.status, probe_id = excluded.probe_id, checked_at = excluded.checked_at, expires_at = excluded.expires_at, evidence = excluded.evidence`,
    capability, subject, status, pid, at, new Date(ctx.now() + ttl).toISOString(), evidence);
  // Present again: every open request that was permitted for it is answered and closes.
  if (status === 'present') await run(ctx.db, `UPDATE gate_cards SET status = 'closed', closed_at = ? WHERE status = 'open' AND id IN (SELECT card_id FROM access_permits WHERE capability = ? AND subject = ?)`, at, capability, subject);
  return { capability, subject, status, checked_at: at, routes: results };
}

export const stateOf = (ctx, capability, subject) => first(ctx.db, `SELECT * FROM access_state WHERE capability = ? AND subject = ?`, capability, subject);

/**
 * The only door to the owner for an access request. Probes fresh, then files the card with its permit when (and only when) the
 * capability is missing on every route. Otherwise nothing is filed and the result says what to do instead.
 * g: { capability, subject, id, what, why_gated, default_in_effect, closing_probe, prepared_by_fleet? }
 */
export async function askOwner(ctx, g = {}) {
  for (const k of ['capability', 'subject', 'id', 'what', 'why_gated', 'default_in_effect', 'closing_probe']) if (!g[k]) throw new Error(`access: askOwner needs ${k}`);
  const st = await probe(ctx, g.capability, g.subject, { registry: ctx.registry || CAPABILITIES });
  if (st.status !== 'missing') {
    const why = st.status === 'present' ? 'already_granted' : 'not_proven_missing';
    await run(ctx.db, `INSERT OR IGNORE INTO access_blocked_asks (card_id, what, why_gated, reason, blocked_at) VALUES (?,?,?,?,?)`, g.id, g.what, g.why_gated, `${why}: ${st.routes.map(r => `${r.route}=${r.outcome}`).join(', ')}`, st.checked_at);
    return { asked: false, reason: why, state: st };
  }
  const tried = st.routes.map(r => `${r.route}: ${r.outcome} (${r.detail})`).join('; ');
  await run(ctx.db, `INSERT OR IGNORE INTO access_permits (card_id, capability, subject, at) VALUES (?,?,?,?)`, g.id, g.capability, g.subject, st.checked_at);
  await run(ctx.db, `INSERT OR IGNORE INTO gate_cards (id, what, why_gated, default_in_effect, prepared_by_fleet, closing_probe) VALUES (?,?,?,?,?,?)`,
    g.id, g.what, `${g.why_gated} Routes tried: ${tried}`, g.default_in_effect, g.prepared_by_fleet || 'access preflight', g.closing_probe);
  return { asked: true, card: g.id, state: st };
}

/** Probes for every listed need, in the form config.needs = [{ capability, subject, owner_only? }]. */
export async function probeAll(ctx, needs = ctx.config?.needs || []) {
  const out = [];
  for (const n of needs) out.push(await probe(ctx, n.capability, n.subject, { registry: ctx.registry || CAPABILITIES }));
  return out;
}

/** What the system has refused to ask, and what is still open: the metric whose target is zero asks that were not permitted. */
export async function report(ctx) {
  return {
    state: await all(ctx.db, `SELECT capability, subject, status, checked_at FROM access_state ORDER BY capability, subject`),
    blocked_asks: await all(ctx.db, `SELECT card_id, reason FROM access_blocked_asks ORDER BY blocked_at`),
    open_cards_without_permit: await all(ctx.db, `SELECT id FROM gate_cards WHERE status = 'open' AND id IN (SELECT card_id FROM access_blocked_asks)`),
  };
}

/**
 * Acquisition item for a blocked ask closes when its capability is present; the probe is 'access:<card>'.
 * Run each tick: re-probe the listed needs, close items whose capability is present.
 */
export async function step(ctx) {
  const states = await probeAll(ctx);
  let closed = 0;
  for (const b of await all(ctx.db, `SELECT card_id FROM access_blocked_asks`)) {
    const card = await first(ctx.db, `SELECT what FROM gate_cards WHERE id = ?`, b.card_id);
    const want = (ctx.config?.closers || {})[b.card_id];
    if (!want || !card) continue;
    const s = states.find(x => x.capability === want.capability && x.subject === want.subject);
    if (s && s.status === 'present') {
      const r = await run(ctx.db, `UPDATE items SET status = 'done', disposition = ?, updated_at = ? WHERE id = ? AND status NOT IN ('done','superseded','cancelled')`, 'capability present per access probe', iso(ctx), 'ACCESS-' + b.card_id);
      closed += r.meta.changes;
    }
  }
  return { probed: states.length, present: states.filter(s => s.status === 'present').length, missing: states.filter(s => s.status === 'missing').length, unknown: states.filter(s => s.status === 'unknown').length, items_closed: closed };
}
export const accessSteps = ({ db, now, fetch, env, config }) => [{ name: 'access', run: async (_db, tick) => {
  const cfg = config?.access;
  if (!cfg || cfg.enabled === false) { tick.notes?.push('access: off'); return; }
  const o = await step({ db, now: typeof now === 'function' ? now : () => now, fetch, env: env || {}, config: cfg });
  tick.notes?.push(`access: ${JSON.stringify(o)}`);
} }];
