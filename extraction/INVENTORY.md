<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# Extraction inventory (2026-11-11)

Goal: the `ultrastable` GitHub organization is a complete, self-standing product code base with no dependency on QNFO internals. QNFO is a documented demo instance and first customer, nothing more. Classification comes from [boundary.json](boundary.json); this file says, per unit, where it stands.

Method: every top-level unit of the QNFO worker repository was classified `core` (the product), `app` (QNFO research and reach applications) or `personal` (never shipped). Size is source bytes excluding release snapshots and deployed-copy duplicates; "QNFO refs" is the count of lines naming QNFO, its handles, hosts or account ids, which is the genericization work remaining. Extraction means rewriting to the module rules in [core/README.md](../core/README.md) (ports, configuration, no tenant names, own migrations, tests), not copying files.

Legend: BUILT = generic module exists here with tests. PLANNED = target and order set, not yet written.

## Core workers (19)

| QNFO worker | Bytes | QNFO refs | Product module | Status |
|---|---:|---:|---|---|
| deploy-guard (work claims, secret lease) | 224k | 264 | `core/claims` | BUILT |
| ops (canonical deploy, lock, ledger) | 1.7M | 1589 | `core/deploy` + `adapters/*/deployer.js` | BUILT (change path); ops agent PLANNED |
| ai (model router, gates, budget routing) | 792k | 584 | `core/router` | BUILT |
| fleet-control (tick, metrics, trust, loop watch) | 3.2M | 1863 | `core/kernel` (L1 + L2), `core/src/tick.js` | BUILT for tick, metrics, lifecycle, failure modes; charter, portfolio and research-specific steps stay QNFO |
| ai-yield (cost per output dashboard) | 15k | 9 | `core/yield` | BUILT (this change): ledger and rules; the owner-code login page is not extracted, the guided console is the generic surface |
| waste-agent (finds spend that produces nothing) | 13k | 16 | `core/yield` | BUILT (this change): rules W-ERR, W-RATE, W-META, W-YIELD with item lifecycle |
| doc-gate (documents tied to work) | 14k | 20 | `core/docgate` | BUILT (this change): storage-agnostic store port |
| code-orchestrator (issue to tested, merged PR) | 1.3M | 959 | `core/codeloop` | PLANNED, extraction order 5 |
| ai-calibration (probe every model endpoint) | 388k | 351 | `core/router` calibration submodule | PLANNED, order 6 |
| observability (trace ingest, scorers) | 162k | 231 | `core/observe` | PLANNED, order 7 |
| memory-mcp (code topology graph, blast radius) | 224k | 91 | `core/graph` | PLANNED, order 8 |
| cloud-ops (task runner, owner-step watch) | 985k | 615 | `core/tasks` | PLANNED, order 9 |
| github-steward (issue ledger mirror) | 414k | 361 | `adapters/github` | PLANNED, order 10 |
| intent-orchestrator (request to issue) | 92k | 76 | `core/intent` | PLANNED, order 11 |
| tools-mcp (MCP server for agent clients) | 107k | 101 | `adapters/mcp` | PLANNED, order 12 |
| agents (Agents SDK runtime) | 2.9M | 180 | `adapters/cloudflare/agents` | PLANNED, order 13 (mostly vendored SDK; do not copy vendor code) |
| containers-pilot (container executor) | 49k | 49 | `adapters/cloudflare/containers` | PLANNED, order 14 |
| infra (shared routes) | 338k | 224 | folded into adapters | PLANNED, order 15 |
| fleet-dashboard (operator console) | 2.8M | 1995 | `apps/console` (the guided console already serves the generic path) | PLANNED, order 16; the QNFO dashboard repo is demo-instance only |

## Other units

| Unit | Decision |
|---|---|
| `scripts/` (560 files): 10 core scripts listed in boundary.json (canary revert, deploy probes, review gate, fleet graph, run-suites, release, migrations, remediation consumer, outline, boundary check) | PLANNED: port to `tools/`, same order as the module each serves. The other ~550 are one-off patches for QNFO's own fleet: not extracted |
| `.github/workflows/` (77): 7 core workflows in boundary.json | PLANNED as manual-trigger templates under `adapters/github/workflows/`; no scheduled workflows (Actions budget rule) |
| `migrations/` (2221 files, 21 MB) | Not copied. The 22 core tables in boundary.json are re-derived as per-module migrations (`core/*/migrations`), idempotent and tenant-free |
| `_shared/` (UI helpers, voice, design system, paper formatting) | App-side and QNFO-styled: not extracted. The console has its own UI |
| `AGENTS.md`, `agents/` roles, `docs/DOCTRINE-KERNEL.md`, `docs/AUTONOMOUS-OPERATION-DOCTRINE.md` | BUILT as the generic policy pack: `agents/`, `autonomy/policy.json`, `docs/seed.md` (P1). QNFO owner directives stay QNFO |
| `product/` (claims page data) | PLANNED: product claims feed on the product's own host (issue #10 in the system of record) |
| 12 `app` workers (research, idea-hub, outreach, email, social, pdf, gateway, ...) | Stay in QNFO. Not product |
| 8 `personal` workers and `docs/` (business plan, career, closeouts, handoffs) | Never copied. Private to the owner |
| `archive/`, `audits/`, `papers/`, `research-code/`, `funding/`, `android-me/`, branch-cleanup files | Not product. Not copied |
| `QNFO/qnfo-fleet-dashboard` repository | Source for `apps/console` extraction (order 16). 32 files, QNFO-styled |

## Rules this inventory enforces

1. A unit is `BUILT` only with tests passing in `core/` CI and `core/test/no-qnfo.test.js` green.
2. QNFO appears in this repository only in documentation (origin, first customer, this inventory) and in the negative lists of the guard tests.
3. Secrets: none are read or copied. Account ids, database ids and owner addresses found in QNFO sources are listed by the guard as forbidden and replaced by configuration.

## Verification log

- 2026-11-11: `core/yield` 5 tests, `core/docgate` 4 tests, separation guard green. Code search across the `ultrastable` org for the QNFO account id, database id, owner address and `qnfo-audit` returned 0 hits (the search index can lag; the separation guard scans the working tree directly and is the authority). Full core suite: 155 pass, 0 fail.
