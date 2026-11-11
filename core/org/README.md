<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/org: the composition root

One object that starts every loop on one tick and serves every route of one organization. Specs: US-SPEC-03 (tick, L2), 08 (claims), 09 (router), 11 (runner), 14, 21 (packs), 22 (describe), 23. Both adapters (`adapters/cloudflare/src/index.js`, `adapters/gcp/server.js`) call only this.

```js
import { createOrg } from './core/org/index.js';
const org = createOrg({ db, env, config, fetch, now, readFile });
await org.tick();                       // cron / POST /tick
const res = await org.handle(request);  // a Response, or null when the path is not the org's
```

`createOrg` returns `{ extraSteps(), tick(), handle(request), packs }`. Optional injections: `vcs`, `router`, `store` (docgate), `channels` and `importer` (packs), `specStatus`, `voiceRules`, `scope`, `compose`, `outputs(days)`. `now` is a function returning milliseconds.

## How the loops start

There is nothing to start. The first `tick()` runs the seven seed steps and then every step below, each guarded by `runTick`: a step that throws is recorded in `tick_runs.errors`, files a `TICKFAIL-<step>-<hour>` item, and the next step still runs. A migration directory applied once (below) is the only setup.

## Order of the steps

| # | Step | What it does |
|---|---|---|
| 1-7 | seed | reconcile, reap_claims, probe_gates, score_predictions, accrue_trust, dispatch, check_plus_share |
| 8 | `l2` | kernel: metrics, risk snapshot, detectors, allocation, focus, decisions, remedies, remediation, lifecycle |
| 9 | `claims_reap` | `claims.reapExpired`: expired locks released |
| 10 | `claims_release_terminal` | `claims.releaseTerminal`: locks on done or cancelled items released |
| 11 | `describe` | probe claims, withdraw stale ones, render and store `statement`, `page`, `json`, `llms` (db writes only) |
| 12 | `yield` | cost-per-output and waste sweep; `outputs(days)` defaults to items done in the window |
| 13 | `docgate` | only when a `store` is injected |
| 14 | `packs` | `packSteps()`: only ENABLED packs run; none by default |
| 15 | `runner` or `runner_needs` | only when `config.runner.enabled === true` |

## The runner gate

The runner step is added only when `config.runner.enabled` is true and every name it needs is present in `env` (presence only). Otherwise a `runner_needs` step files one `gate_cards` row per missing name, once (stable id `runner-needs-<NAME>`), text `runner needs: <NAME>`, default in effect "the runner is skipped; every other loop keeps running", closing probe `env:<NAME>` (the seed `probe_gates` step closes it when the secret appears). The console lists it as a secret card. Names needed:

| Need | Name |
|---|---|
| VCS token | `config.vcs.token_env` (default `VCS_TOKEN`) |
| At least one model provider key | any `key_env` under `config.router.providers` (all are listed when none is set) |
| Repository | `config.vcs.repo` (unless a `vcs` is injected), `config.router.providers` (a `manual` card) |

## Configuration keys read

`org_slug`, `claim_ttl_minutes`, `max_wip_per_role`, `plus_share`, `policy` (seed); `kernel` (L2); `claims`; `router` (providers, caps; see `core/router/example-config.json`); `runner` (`enabled`, limits); `vcs` (`repo`, `base`, `token_env`); `yield`; `docgate`; `packs` (pack host config, with per-pack settings under `packs.packs.<id>`); `describe` (`scope`, `voice_rules`, `spec_status`); `pack_migrations` (build time, below).

## Secrets (env names, never values)

`CONSOLE_TOKEN` (the console is off without it), `VCS_TOKEN` (or `config.vcs.token_env`), each provider's `key_env`. The tick receives only `{ NAME: true }`. Values are read per request by the router and the VCS adapter and are scrubbed from stored errors; the end-to-end test dumps every table and asserts no secret value is in any.

## Routes (`handle`)

`/health` (same shape as the seed Worker: `{ ok, org, last_tick }`, 503 until a tick completes), `/console*` and `/api/console*`, `/describe`, `/describe.json`, `/llms.txt`. Anything else returns `null`.

## Migrations

`modules.js` is the ordered module list (core, claims, router, kernel, runner, describe, packs, yield, docgate, then `packs/<id>/migrations` for each id in `config.pack_migrations`). `node tools/build_migrations.mjs [--config file.json] [--check]` writes `adapters/cloudflare/migrations/NNNN_<module>_<name>.sql`; the output is committed and `migrations.test.js` fails on drift and applies all files twice to a fresh database. The Worker template points `migrations_dir` at it. Adding a migration to an earlier module renumbers later files; every migration is idempotent, so a re-run is safe.

## Not covered here

Pack code is loaded by directory through the injected `importer` (default Node dynamic import), so a Worker bundle runs packs only when an importer for bundled packs is passed. The `deploy` module is not started.
