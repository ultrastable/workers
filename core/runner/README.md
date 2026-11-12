<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/runner: the doer/reviewer runner

Lets the system write its own pull requests (`US-SPEC-11`, with 02, 05, 08, 09 and 15 s5.3). A Worker cannot run a test suite, so verification is the repository's CI, an independent system. A run is a state machine stored in `runner_runs`, advanced a little each tick (I/O only, so it fits a free-plan CPU budget):

`planned -> patched -> checks_pending -> checks_passed | checks_failed -> reviewing -> approved -> pr_opened` (a DRAFT pull request, never merged by the runner), or `rework` (max 2, then a decision card and the run stops), or `refused` (budget, protected path, kill switch, invalid output, repeated errors).

## Wiring

```js
import { createRunner, runnerExtraSteps } from './core/runner/index.js';
import { createGithubVcs } from './core/runner/vcs-github.js';
import { createRouter } from './core/router/router.js';
import * as claims from './core/claims/index.js';

const vcs = createGithubVcs({ fetch, repo: 'owner/name', base: 'main', env, tokenEnv: 'VCS_TOKEN' });
const router = createRouter({ db, fetch, now, config: routerConfig, env });
const runner = createRunner({ db, fetch, now, config: { runner: { enabled: true }, claims: {} }, env, router, claims, vcs });
await runTick(db, { config, extraSteps: [...L2_EXTRA_STEPS, ...runnerExtraSteps(runner)] });
```

`runner.step()` advances active runs and, when enabled and below max work in progress, starts the top ready item whose owner role is `staff`. `startRun(item|id)` starts one explicitly. `status()` reports counts, spend and the protected list. Do not give the same org a seed `roles` row for `staff`: the seed `dispatch` step would claim those items first.

Migrations: `core/runner/migrations/0001_runner.sql` (after `claims` and `router`). Tables: `runner_runs`, `runner_events`, `runner_item_context`.

## What a person must configure

| What | Where |
|---|---|
| Repository and base branch | `createGithubVcs({ repo, base })` |
| Token presence | env variable named by `tokenEnv` (default `VCS_TOKEN`). Use a token that can push branches and open pull requests; pushes made with the Actions-provided token do not start workflows, so use a fine-grained token or an app token. Read per request, never stored or logged |
| Model providers | router config (`core/router/example-config.json`): at least two provider families with a `medium` rung and the `json` capability, or the reviewer is refused (`no_distinct_family`) |
| Enable | `config.runner.enabled: true` (default false: autonomy zero, supervised first week) |
| Per-item context | `runner_item_context` row (`spec_ref`, `spec_text`, `targets` JSON, `test_path`, `failing_test`), or `spec:`, `target:`, `test:`, `failing test:` lines in the item's `done_check`. An item with no target becomes a decision card |
| Limits | `max_wip` 1, `max_rework` 2, `max_calls_per_item` 8, `max_usd_per_item` 1, `max_files` 5, `checks_timeout_minutes` 90, `protected_paths` (added to the defaults, never replacing them) |
| Spend caps and kill switch | router config `caps` and `router.setSwitch('all', true)` |

Default protected paths: `SCOPE.md`, `LICENSE`, `COMMERCIAL-TERMS.md`, `autonomy/`, `self/`, `.github/`, `core/test/no-qnfo.test.js`.

## Requirement status

| Requirement | Status | Where |
|---|---|---|
| US-11 one ready `staff` item per run, claimed, bounded work in progress | BUILT | `step`, `startRun`, `core/claims` |
| US-11 minimal context (spec text, named targets, named test) | BUILT | `buildContext` |
| US-11 doer through the router at the medium rung, strict JSON, strict validation | BUILT (whole-file replacements) / PLANNED (unified diff input) | `parseDoerOutput` |
| US-11 verification by repository CI, polled across ticks | BUILT | `pollChecks`, `vcs.getChecks` |
| US-11 reviewer of a different family, strict schema, sees diff, checks and done check | BUILT | `review`; family exclusion is the router's (US-09-R13) |
| US-11 draft PR only, body quotes real checks and the spec served; never merged | BUILT | `openPr`; the Vcs port has no merge |
| US-11 rework max 2, then decision card | BUILT | `toRework` |
| US-02 / SELF-HOSTING s4 protected paths owner-reviewed | BUILT | `isProtected`, refusal files a `gate_cards` row |
| US-05 prediction before the doer call, scored after | BUILT (one prediction per run: will the checks pass) | `predictions` row `runner-<run>` |
| US-15 s5.3 outcomes feed the trust ledger | BUILT (`verified`, `failed`, `hidden_failure` once per run; surface `pull_request`, class `doer_pr`) | `outcomes` |
| US-09 per-item, day, month caps and kill switch | BUILT (item caps here; day and month caps and the switch are the router's) | `llm` |
| US-08 claim per item, heartbeat, release | BUILT | `core/claims` |
| Run state survives restart; duplicate steps are safe | BUILT | compare-and-set on `state` |
| Unified-diff doer output | PLANNED | |
| Merge, auto-merge, posting review comments on the PR | NOT COVERED (by design: a person merges) | |
| Tracking a merged PR back to closing the item | PLANNED | |
| A non-GitHub Vcs adapter | PLANNED | implement the six-method port |

Hidden failure is recorded when the reviewer rejects a change whose checks were green and the rework limit is then reached.

## Owner-step watch and probe cadence (`ownerwatch.js`, US-SPEC-11)

`watchOwnerSteps` re-probes open gate cards on a cadence (`probe_every_minutes`), closes a card when its closing probe passes (`env:`, `item_done:`, `http:`, or a `ctx.probe` port), files one escalation item after `owner_step_hours` and raises it to priority 95 after twice that. `runCadence` runs named probes when due and files `OPS-PROBE-<name>` after a fail streak. Status: BUILT (`ownerwatch.test.js`).
