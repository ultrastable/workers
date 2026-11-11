// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The composition root: one object that starts every loop on one tick and serves every route of one organization.
// createOrg({ db, env, config, fetch, now, readFile }) -> { extraSteps(), tick(), handle(request), packs }.
// Ports only (db, env, fetch, now, readFile). Optional injections: vcs, router, store, channels, importer, specStatus,
// voiceRules, scope, compose, outputs. The tick learns only that a secret exists; values are read by the router and the
// VCS adapter at call time and are never stored or logged here.
import { runTick } from '../src/tick.js';
import { handleConsole } from '../src/console.js';
import { L2_EXTRA_STEPS } from '../kernel/index.js';
import * as claims from '../claims/index.js';
import { createRouter } from '../router/router.js';
import { createRunner, runnerExtraSteps } from '../runner/index.js';
import { createGithubVcs } from '../runner/vcs-github.js';
import { createVault } from '../vault/index.js';
import { createGithubApp, createInstallationTokenProvider, hasAppCredentials } from '../githubapp/index.js';
import { describeExtraSteps, handle as describeHandle } from '../describe/index.js';
import { createPacks } from '../packs/index.js';
import { sweep as yieldSweep } from '../yield/index.js';
import { sweep as docgateSweep } from '../docgate/index.js';

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
} = {}) {
  const clock = typeof now === 'function' ? now : () => now;
  const doFetch = fetch || ((...a) => globalThis.fetch(...a));
  const packs = createPacks({ db, now: clock, config: config.packs || {}, channels, ...(importer ? { importer } : {}) });
  const dcfg = config.describe || {};
  const secrets = vault || (db ? createVault({ db }) : null);
  let appReady = false; // refreshed at the start of each tick: do the vault's GitHub App credentials exist
  const tokenProvider = secrets ? createInstallationTokenProvider({ vault: secrets, fetch: doFetch, now: clock }) : null;
  const githubApp = secrets ? (request, origin) => createGithubApp({ vault: secrets, fetch: doFetch, now: clock, consoleToken: env.CONSOLE_TOKEN, config: { org: config.vcs?.repo?.split('/')[0], ...(config.githubapp || {}), baseUrl: config.githubapp?.baseUrl || origin } })(request) : null;
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

  function runnerSteps() {
    if (config.runner?.enabled !== true) return [];
    const need = runnerNeeds(config, env, { vcsInjected: !!vcs, appCredentials: appReady });
    if (need.length) return [{ name: 'runner_needs', run: async (_db, ctx) => { await fileRunnerCards(need); ctx.notes.push(`runner skipped: needs ${need.join(', ')}`); } }];
    const r = router || createRouter({ db, fetch: doFetch, now: clock, config: config.router, env, ai: env.AI || null });
    const v = vcs || createGithubVcs({ fetch: doFetch, repo: config.vcs.repo, base: config.vcs.base || 'main', env, tokenEnv: config.vcs?.token_env || 'VCS_TOKEN', ...(!env[config.vcs?.token_env || 'VCS_TOKEN'] && appReady && tokenProvider ? { tokenProvider } : {}) });
    return runnerExtraSteps(createRunner({ db, now: clock, config, env, router: r, claims, vcs: v }));
  }

  const cctx = () => ({ db, now: clock, config: config.claims || {} });
  const defaultOutputs = async days => (await db.prepare(`SELECT COUNT(*) AS n FROM items WHERE status = 'done' AND updated_at >= ?`).bind(iso(clock() - days * 86400e3)).first()).n;

  // Order: kernel L2, claims, describe, yield, docgate, packs, runner. Each is its own guarded step.
  function extraSteps() {
    const steps = [
      ...L2_EXTRA_STEPS,
      { name: 'claims_reap', run: async (_db, ctx) => { const r = await claims.reapExpired(cctx()); ctx.notes.push(`claims reaped: ${JSON.stringify(r)}`); } },
      { name: 'claims_release_terminal', run: async (_db, ctx) => { const r = await claims.releaseTerminal(cctx()); ctx.notes.push(`claims released on terminal items: ${JSON.stringify(r)}`); } },
      { name: 'describe', run: async (d, ctx) => describeExtraSteps({ fetch: doFetch, readFile, specStatus: describeSpec, packs: await describePacks(), scope: describeScope, compose, voiceRules: describeVoice })[0].run(d, ctx) },
      { name: 'yield', run: async (_db, ctx) => { const r = await yieldSweep({ db, now: clock, config: config.yield || {}, outputs: outputs || defaultOutputs }); ctx.notes.push(`yield: ${r.filed} filed, ${r.closed} closed`); } },
    ];
    if (store) steps.push({ name: 'docgate', run: async (_db, ctx) => { const r = await docgateSweep({ db, now: clock, config: config.docgate || {}, store }); ctx.notes.push(`docgate: ${JSON.stringify(r)}`); } });
    steps.push({
      name: 'packs',
      run: async (d, ctx) => { for (const s of await packs.packSteps()) await s.run(d, ctx); }, // each pack step guards and records its own failure
    });
    steps.push(...runnerSteps());
    return steps;
  }

  async function tick() {
    try { appReady = secrets ? await hasAppCredentials(secrets) : false; } catch { appReady = false; }
    return runTick(db, { config, env: presence(env), now: clock(), extraSteps: extraSteps() });
  }

  async function handle(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p === '/health') {
      const last = await db.prepare(`SELECT id, started_at, finished_at, steps_completed, steps_total, report, errors FROM tick_runs ORDER BY id DESC LIMIT 1`).first();
      const ok = Boolean(last && last.steps_completed === last.steps_total);
      return Response.json({ ok, org: config.org_slug, last_tick: last || null }, { status: ok ? 200 : 503 });
    }
    if (githubApp && p.startsWith('/console/github/')) return githubApp(request, url.origin);
    if (p === '/console' || p.startsWith('/console/') || p.startsWith('/api/console')) {
      return handleConsole(request, { DB: db, CONSOLE_TOKEN: env.CONSOLE_TOKEN }, { org: config.org_slug });
    }
    if (ROUTES.has(p.replace(/\/+$/, '') || '/')) {
      return describeHandle(request, { db, now: clock(), specStatus: describeSpec, packs: await describePacks(), scope: describeScope, compose, voiceRules: describeVoice });
    }
    return null;
  }

  return { extraSteps, tick, handle, packs };
}
