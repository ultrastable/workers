// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The composition root: one object that starts every loop on one tick and serves every route of one organization.
// createOrg({ db, env, config, fetch, now, readFile }) -> { extraSteps(), tick(), handle(request), packs }.
// Ports only (db, env, fetch, now, readFile). Optional injections: vcs, router, store, channels, importer, specStatus,
// voiceRules, scope, compose, outputs, metrics (domain metrics for scoring predictions: { name: async (db, nowMs, row) => number }). The tick learns only that a secret exists; values are read by the router and the
// VCS adapter at call time and are never stored or logged here.
import { runTick } from '../src/tick.js';
import { handleConsole } from '../src/console.js';
import { createVault } from '../vault/index.js';
import { sweepFirstRun } from '../doors/index.js';
import { createConsoleL3 } from '../console-l3/index.js';
import { L2_EXTRA_STEPS } from '../kernel/index.js';
import * as claims from '../claims/index.js';
import { createRouter } from '../router/router.js';
import { createRunner, runnerExtraSteps } from '../runner/index.js';
import { createGithubVcs } from '../runner/vcs-github.js';
import { createSignin } from '../githubapp/signin.js';
import { createGithubApp, createInstallationTokenProvider, hasAppCredentials } from '../githubapp/index.js';
import { describeExtraSteps, handle as describeHandle } from '../describe/index.js';
import { createPacks } from '../packs/index.js';
import { sweep as yieldSweep } from '../yield/index.js';
import { sweep as docgateSweep } from '../docgate/index.js';
import { steward as stewardRun, rollup as stewardRollup } from '../steward/index.js';
import { wasteRun } from '../waste/index.js';
import { watchOwnerSteps } from '../runner/ownerwatch.js';
import { createAgents } from '../agents/index.js';
import { createContainers } from '../containers/index.js';
import { createInfra, heartbeat } from '../infra/index.js';
import { createElicit } from '../elicit/index.js';
import { guardSteps, seedBacklog } from '../runner/selfdoer.js';
import { handlePublicMetrics } from './public-metrics.js';

export { MODULES, moduleList } from './modules.js';

/** Which env names are set, as { NAME: true }. Values never leave the env object. */
export function presence(env = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && v) out[k] = true;
  return out;
}

/** Names the runner still needs, from config and env presence only. Empty means it can run. */
export function runnerNeeds(config = {}, env = {}, { vcsInjected = false, appCredentials = false } = {}) {
  const need = [];
  const tokenEnv = config.vcs?.token_env || 'VCS_TOKEN';
  if (!env[tokenEnv] && !appCredentials) need.push(tokenEnv);
  if (!vcsInjected && !config.vcs?.repo) need.push('config.vcs.repo');
  const providers = Object.values(config.router?.providers || {});
  if (!providers.length) need.push('config.router.providers');
  else if (!providers.some(p => (p.kind === 'workers_ai' ? !!env.AI : p.key_env && env[p.key_env]))) {
    for (const p of providers) { if (p.kind === 'workers_ai') need.push('AI'); else if (p.key_env) need.push(p.key_env); }
  }
  return [...new Set(need)];
}

const ROUTES = new Set(['/describe', '/describe.json', '/llms.txt']);
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

export function createOrg({
  db, env = {}, config = {}, fetch, now = () => Date.now(), readFile,
  vcs, router, store, vault, channels = {}, importer, specStatus = null, voiceRules, scope, compose, outputs,
  sinks = [], gauges = {}, executors = [], agentDefs = {}, hooks = {}, routes = [], checks = {}, stepRuns, metrics = {},
} = {}) {
  const vaultStore = vault || createVault({ db });
  // The env the modules see: real env values win, a vault secret fills a missing name. Never logged or stored.
  const mergedEnv = async () => { try { return await vaultStore.withVault(env); } catch { return env; } };
  const clock = typeof now === 'function' ? now : () => now;
  const doFetch = fetch || ((...a) => globalThis.fetch(...a));
  const packs = createPacks({ db, now: clock, config: config.packs || {}, channels, ...(importer ? { importer } : {}) });
  const dcfg = config.describe || {};
  const secrets = vaultStore;
  let appReady = false; // refreshed at the start of each tick: do the vault's GitHub App credentials exist
  const tokenProvider = secrets ? createInstallationTokenProvider({ vault: secrets, fetch: doFetch, now: clock }) : null;
  const githubApp = secrets ? (request, origin) => createGithubApp({ vault: secrets, fetch: doFetch, now: clock, consoleToken: env.CONSOLE_TOKEN, config: { org: config.vcs?.repo?.split('/')[0], ...(config.githubapp || {}), baseUrl: config.githubapp?.baseUrl || origin } })(request) : null;
  const l3 = createConsoleL3({ db, now: clock, config: { version: config.version } });
  const describeScope = scope || dcfg.scope || {};
  const describeVoice = voiceRules || dcfg.voice_rules || {};
  const describeSpec = specStatus || dcfg.spec_status || null;

  async function describePacks() {
    try {
      return (await packs.status()).map(p => ({ id: p.id, enabled: !!p.enabled }));
    } catch { return []; }
  }

  // A missing secret becomes one decision card per name, filed once (the id is stable), default in effect, closed by its probe.
  async function fileRunnerCards(names) {
    for (const name of names) {
      const probe = name.startsWith('config.') ? 'manual' : `env:${name}`;
      await db.prepare(`INSERT OR IGNORE INTO gate_cards (id, what, why_gated, default_in_effect, prepared_by_fleet, closing_probe) VALUES (?,?,?,?,?,?)`)
        .bind(`runner-needs-${name.replace(/[^A-Za-z0-9]+/g, '-')}`, `runner needs: ${name}`,
          'The runner is enabled in the configuration but this setting is missing, so it cannot open pull requests.',
          'the runner is skipped; every other loop keeps running', 'org', probe).run();
    }
  }

  function runnerSteps(env) {
    if (config.runner?.enabled !== true) return [];
    const need = runnerNeeds(config, env, { vcsInjected: !!vcs, appCredentials: appReady });
    if (need.length) return [{ name: 'runner_needs', run: async (_db, ctx) => { await fileRunnerCards(need); ctx.notes.push(`runner skipped: needs ${need.join(', ')}`); } }];
    const r = router || createRouter({ db, fetch: doFetch, now: clock, config: config.router, env, ai: env.AI || null });
    const v = vcs || createGithubVcs({ fetch: doFetch, repo: config.vcs.repo, base: config.vcs.base || 'main', env, tokenEnv: config.vcs?.token_env || 'VCS_TOKEN', ...(!env[config.vcs?.token_env || 'VCS_TOKEN'] && appReady && tokenProvider ? { tokenProvider } : {}) });
    const steps = runnerExtraSteps(createRunner({ db, now: clock, config, env, router: r, claims, vcs: v }));
    // Self-hosting (issue #13): an outer spend cap around every runner step, on top of the router's own caps.
    return on('selfdoer') ? guardSteps(steps, { db, now: clock, caps: config.selfdoer.caps || {} }) : steps;
  }

  // Opt-in modules: each is off unless config.<name>.enabled === true; its ports come from the injections above.
  const on = name => config[name]?.enabled === true;
  let built = null; // built on first use, so an agents flag without router config costs nothing until a turn runs
  const lazyRouter = { call: (...a) => (built ||= createRouter({ db, fetch: doFetch, now: clock, config: config.router, env, ai: env.AI || null })).call(...a) };
  const agents = on('agents')
    ? createAgents({ db, router: router || lazyRouter, now: clock, config: config.agents, hooks })
    : null;
  if (agents) for (const [name, def] of Object.entries(agentDefs)) agents.define(name, def);
  const elicit = on('elicit') ? createElicit({ db, now: clock, config: config.elicit }) : null;
  const containersFor = e => (on('containers') && executors.length
    ? createContainers({ db, now: clock, config: config.containers, executors, secrets: (config.containers.secret_env || []).map(n => e[n]).filter(Boolean) }) : null);
  const infraRoutes = () => {
    const r = [...routes];
    if (agents) r.push({ prefix: '/api/agents', methods: ['POST'], tokenEnv: 'CONSOLE_TOKEN', handler: async request => {
      const m = new URL(request.url).pathname.match(/^\/api\/agents\/([a-z][a-z0-9-]*)\/turn$/);
      if (!m) return Response.json({ error: 'not found' }, { status: 404 });
      let body; try { body = await request.json(); } catch { return Response.json({ error: 'json body required' }, { status: 400 }); }
      if (!body || typeof body.session !== 'string' || typeof body.text !== 'string') return Response.json({ error: 'session and text required' }, { status: 400 });
      return Response.json(await agents.turn(m[1], body.session, body.text));
    } });
    if (elicit) r.push({ prefix: '/api/elicit', methods: ['GET'], tokenEnv: 'CONSOLE_TOKEN', handler: async request => {
      const u = new URL(request.url), project = u.searchParams.get('project');
      if (!project) return Response.json({ error: 'project required' }, { status: 400 });
      if (u.pathname === '/api/elicit/readiness') return Response.json(await elicit.readiness(project));
      if (u.pathname === '/api/elicit/asks') return Response.json(await elicit.nextAsks(project));
      return Response.json({ error: 'not found' }, { status: 404 });
    } });
    return r;
  };

  const cctx = () => ({ db, now: clock, config: config.claims || {} });
  const defaultOutputs = async days => (await db.prepare(`SELECT COUNT(*) AS n FROM items WHERE status = 'done' AND updated_at >= ?`).bind(iso(clock() - days * 86400e3)).first()).n;

  // Order: kernel L2, claims, describe, yield, docgate, packs, runner. Each is its own guarded step.
  function extraSteps(env_ = env) {
    const steps = [
      ...L2_EXTRA_STEPS,
      { name: 'claims_reap', run: async (_db, ctx) => { const r = await claims.reapExpired(cctx()); ctx.notes.push(`claims reaped: ${JSON.stringify(r)}`); } },
      { name: 'claims_release_terminal', run: async (_db, ctx) => { const r = await claims.releaseTerminal(cctx()); ctx.notes.push(`claims released on terminal items: ${JSON.stringify(r)}`); } },
      { name: 'describe', run: async (d, ctx) => describeExtraSteps({ fetch: doFetch, readFile, specStatus: describeSpec, packs: await describePacks(), scope: describeScope, compose, voiceRules: describeVoice })[0].run(d, ctx) },
      // waste (opt-in) runs the same yield sweep and then the gauge rules, so it replaces the yield step rather than doubling it.
      on('waste')
        ? { name: 'waste', run: async (_db, ctx) => { const r = await wasteRun({ db, now: clock, config: { ...(config.yield || {}), ...config.waste }, outputs: outputs || defaultOutputs, gauges }); ctx.notes.push(`waste: ${r.filed} filed, ${r.closed} closed, ${r.gauge_findings} gauge findings`); } }
        : { name: 'yield', run: async (_db, ctx) => { const r = await yieldSweep({ db, now: clock, config: config.yield || {}, outputs: outputs || defaultOutputs }); ctx.notes.push(`yield: ${r.filed} filed, ${r.closed} closed`); } },
    ];
    if (store) steps.push({ name: 'docgate', run: async (_db, ctx) => { const r = await docgateSweep({ db, now: clock, config: config.docgate || {}, store }); ctx.notes.push(`docgate: ${JSON.stringify(r)}`); } });
    steps.push({
      name: 'packs',
      run: async (d, ctx) => { for (const s of await packs.packSteps()) await s.run(d, ctx); }, // each pack step guards and records its own failure
    });
    steps.push(...runnerSteps(env_));
    // Self-hosting backlog: the specification backlog (tools/spec_backlog.py --json) and a target map, both read through readFile.
    if (on('selfdoer') && readFile && config.selfdoer.backlog_path) steps.push({ name: 'selfdoer_seed', run: async (_db, ctx) => {
      const items = JSON.parse(await readFile(config.selfdoer.backlog_path));
      const targets = config.selfdoer.targets_path ? JSON.parse(await readFile(config.selfdoer.targets_path)) : {};
      const r = await seedBacklog(db, Array.isArray(items) ? items : [], targets);
      ctx.notes.push(`selfdoer_seed: ${r.seeded} seeded (${r.ready} ready, ${r.open} open), ${r.existing} already present`);
    } });
    // Opt-in loops, after the runner so they never delay it. Each is its own guarded step.
    if (on('steward') && sinks.length) steps.push({ name: 'steward', run: async (_db, ctx) => { const r = await stewardRun({ db, now: clock, config: config.steward, sinks }); ctx.notes.push(`steward: ${r.synced} synced, ${r.failed} failed, ${r.unplaced.length} unplaced, ${r.filed} filed`); } });
    if (on('ownerwatch')) steps.push({ name: 'ownerwatch', run: async (_db, ctx) => { const r = await watchOwnerSteps({ db, now: clock, config: config.ownerwatch, env: presence(env_), fetch: doFetch }); ctx.notes.push(`ownerwatch: ${JSON.stringify(r)}`); } });
    const containers = containersFor(env_);
    if (containers) steps.push({ name: 'containers', run: async (_db, ctx) => { const reaped = await containers.reap(); const ran = await containers.runNext(); ctx.notes.push(`containers: reaped ${JSON.stringify(reaped)}, ran ${ran ? ran.status || ran.skipped : 'none'}`); } });
    if (agents) steps.push({ name: 'agents', run: async (_db, ctx) => { await agents.expire(); ctx.notes.push('agents: expired approvals swept'); } });
    if (elicit) steps.push({ name: 'elicit', run: async (_db, ctx) => {
      let n = 0; for (const r of (await db.prepare(`SELECT DISTINCT project FROM elicit_needs WHERE state='asked'`).all()).results || []) n += await elicit.expire(r.project);
      ctx.notes.push(`elicit: ${n} asks defaulted on timeout`);
    } });
    if (on('console_l3') && typeof stepRuns === 'function') steps.push({ name: 'console_l3', run: async (_db, ctx) => { const f = await l3.sweepStepBudgets(await stepRuns()); ctx.notes.push(`console_l3: ${f.length} step-budget findings`); } });
    if (on('infra')) steps.push({ name: 'infra', run: async (_db, ctx) => { await heartbeat({ db, now: clock }, 'tick', config.infra.tick_every_minutes ?? null); ctx.notes.push('infra: tick heartbeat recorded'); } });
    return steps;
  }

  async function tick() {
    try { appReady = secrets ? await hasAppCredentials(secrets) : false; } catch { appReady = false; }
    const e = await mergedEnv();
    // Let an unclaimed first-run window expire (and file its card) even if nobody visits; not a tick step, so the step list is unchanged.
    if (config.doors) await sweepFirstRun(db, { now: clock(), config: config.doors, hasKey: Boolean(e.CONSOLE_TOKEN) || Boolean(config.doors?.access?.team_domain) }).catch(() => {});
    return runTick(db, { config, env: presence(e), now: clock(), extraSteps: extraSteps(e), metrics });
  }

  async function handle(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p === '/health') {
      const last = await db.prepare(`SELECT id, started_at, finished_at, steps_completed, steps_total, report, errors FROM tick_runs ORDER BY id DESC LIMIT 1`).first();
      const ok = Boolean(last && last.steps_completed === last.steps_total);
      // Issue #173 probe: claims released with no work in the last 24 h (dispatch that nothing executed).
      const since = new Date(clock() - 864e5).toISOString().slice(0, 19).replace('T', ' ');
      let unworked = null;
      try { unworked = (await db.prepare(`SELECT COUNT(*) AS n FROM outcomes WHERE surface='dispatch' AND action_class='claim_release' AND result='unworked' AND at >= ?`).bind(since).first())?.n ?? 0; } catch { /* store without the table */ }
      return Response.json({ ok, org: config.org_slug, last_tick: last || null, claims_released_unworked_24h: unworked }, { status: ok ? 200 : 503 });
    }
    if (secrets && config.vcs?.repo && p.startsWith('/console/github/signin')) return createSignin({ vault: secrets, fetch: doFetch, now: clock, repo: config.vcs.repo })(request);
    if (githubApp && p.startsWith('/console/github/')) return githubApp(request, url.origin);
    if (p === '/console' || p.startsWith('/console/') || p.startsWith('/api/console')) {
      const e = await mergedEnv();
      return handleConsole(request, { DB: db, CONSOLE_TOKEN: e.CONSOLE_TOKEN }, { org: config.org_slug, vault: vaultStore, doors: config.doors, config, l3, fetch: doFetch, now: clock, envNames: presence(e) });
    }
    if (on('infra') && (p === '/health/deep' || p.startsWith('/api/agents') || p.startsWith('/api/elicit') || routes.some(r => p.startsWith(r.prefix)))) {
      const e = await mergedEnv();
      const r = await createInfra({ routes: infraRoutes(), env: e, db, now: clock, config: config.infra, checks }).dispatch(request);
      if (r) return r;
    }
    if (on('public_metrics')) { const r = await handlePublicMetrics(request, { db, now: clock(), config }); if (r) return r; }
    if (ROUTES.has(p.replace(/\/+$/, '') || '/')) {
      return describeHandle(request, { db, now: clock(), specStatus: describeSpec, packs: await describePacks(), scope: describeScope, compose, voiceRules: describeVoice });
    }
    return null;
  }

  return { extraSteps, tick, handle, packs, agents, elicit, stewardRollup: () => stewardRollup({ db }) };
}
