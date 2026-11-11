<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/deploy: the canonical change path

Implements the deploy half of US-SPEC-07 section 4 independent of any cloud. `createDeploy({ db, deployer, fetch, now, sleep, config, env, lock?, killSwitch?, probes? })` returns `{ deploy, reconcile, handle, ledger, closeGate }`.

`deploy({ unit, artifact, expectedVersion, actor })`: kill-switch and open-gate check, lock, live-version check (stale refused), ledger row, baseline probes, `deployer.publish`, probes polled until all pass or the window closes, then keep or `deployer.rollback` (verified by `liveVersion`). After `breakerThreshold` (default 3) consecutive reverts of one unit a gate-style record opens in `deploy_records` and further deploys of the unit are refused until `closeGate(id)`.

Ports: `db` (D1-style), `deployer` (`publish`, `liveVersion`, `rollback`; adapters in `adapters/cloudflare/deployer.js` and `adapters/gcp/deployer.js`), `fetch`, `now`, `sleep`, `lock` (`acquire(unit, holder, ttlMs) -> token|null`, `release`; built-in `dbLock`), `killSwitch`. Probes are data (`http`: url, status, contains, version; `db`: sql, expect) given in `probes[unit]` or the `deploy_units` table. HTTP: `POST /deploy`, `POST /reconcile`, `GET /ledger?unit=`, all behind an `x-deploy-token` header that must match `env.DEPLOY_TOKEN` (no token configured: everyone refused).

Migration: `migrations/0001_deploy.sql` (tables `deploy_*`, idempotent). Only digests and versions are stored; any configured env value is redacted from stored text.

## Requirement status

| Requirement | Status | Where |
|---|---|---|
| US-07-R12 deploys of one component serialized by a lock | BUILT | `lock.js`, tests "serialized", "expired lock" |
| US-07-R12 probe that passed before and fails after reverts | BUILT, stricter: any failing probe after publish reverts (baseline results are recorded, not used to exempt) | `index.js` |
| US-07-R13 ledger row records the version; artifact compared with source | BUILT: versions and SHA-256 recorded; an optional `artifact.sha256` must match. No byte comparison against a source repository | ledger tests |
| US-07-T05 failing probe reverts, failure recorded | BUILT: ledger row `reverted` with reason. Filing a work item in the seed `items` table is PLANNED (the record lives in `deploy_ledger`/`deploy_records`) | tests |
| US-07-R09 control-plane change only by reviewed change | NOT COVERED here (repository policy and CI) | |
| US-07-R01..R08, R14..R17 governance, recognition, goals | NOT COVERED (other modules) | |
| US-07-R10, R11 two-family review gate and hold marker | NOT COVERED (review gate is a separate module) | |
| US-09-R02 global kill switch refuses deploy leases | BUILT for deploys: `deploy_config kill_switch=on` or injected `killSwitch` | test "kill switch" |
| US-06-R08/R09 gate-style record with closing probe and default in effect | BUILT in form (`deploy_records`, probe `manual`, default stated); linking to seed `gate_cards` PLANNED | loop breaker tests |
| US-06-R10 only presence of secrets recorded | BUILT: values never stored, redacted from stored text | test "no secret value" |
| US-14-R01 core calls no platform API | BUILT: all platform access via ports | `index.js` |
| US-14-R08 deploy port supports revert to prior version | BUILT: `rollback(unit, toVersion)` in both adapters | adapter tests |
| Unlogged mutations detected | BUILT: `reconcile(unit)` writes an `unlogged` ledger row and an open `deploy_records` entry. Scheduling reconcile is the caller's job | test "unlogged" |
| Cloudflare Workers adapter | BUILT against the public HTTP API with a fake fetch; not run against a live account | `adapters/cloudflare/` |
| Cloud Run adapter | PLANNED skeleton, fake-fetch tested; long-running-operation polling absent | `adapters/gcp/deployer.js` |
| Multi-step deploy window with gradual traffic shift | PLANNED | |
