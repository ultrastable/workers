<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# Extraction: moving the core out of the QNFO fleet

Ultrastable was built inside QNFO's Cloudflare Workers fleet (`QNFO/qnfo-workers`, 50+ workers). Each worker there is classified `core` (the product), `app` (QNFO's research and outreach applications, customer zero) or `personal` (never part of the product). This directory tracks moving the `core` workers into this repository.

QNFO's repository stays public and is already licensed under the QNFO Unified License Agreement v2.1 (non-commercial; commercial use needs a separate agreement). The code here is the same Licensor's, offered under the Ultrastable License v1.0. Each worker moves only after its QNFO-specific constants (account, hosts, repository, model ladder, owner contact) are read from configuration.

The classification below is kept as data in `extraction/boundary.json` and enforced by `extraction/product_boundary.mjs`.

## Core workers to extract

| Worker (in QNFO/qnfo-workers) | Role |
|---|---|
| `qnfo-fleet-control` | kernel: the 10-minute tick, metric triggers, loop watch, trust ledger refresh, remediation contracts |
| `qnfo-code-orchestrator` | code loop: issue with a code-task line to a planned, tested, merged pull request on open models |
| `qnfo-deploy-guard` | work claims and the secret lease shared by every agent lane |
| `qnfo-ops` | canonical deploy (/ops/deploy) with lock, ledger and bindings; the server-side ops agent |
| `qnfo-ai` | model router with capability gates, fallbacks and soft budget routing |
| `qnfo-ai-calibration` | calibrates and stress-tests every routed model endpoint |
| `qnfo-ai-yield` | AI cost yield measurement |
| `qnfo-waste-agent` | finds and removes spend that produces nothing |
| `qnfo-memory-mcp` | fleet code and topology graph (blast radius) and the knowledge graph |
| `qnfo-observability` | makes the fleet observable to itself (trace ingest into D1) |
| `qnfo-cloud-ops` | task runner for D1 workflows, owner-step watch and probe cadence |
| `qnfo-github-steward` | mirrors the issue ledger to GitHub and keeps issue hygiene |
| `qnfo-intent-orchestrator` | turns a request from any client into an issue the loops act on |
| `qnfo-tools-mcp` | MCP tool server for agent clients |
| `qnfo-agents` | Cloudflare Agents SDK runtime reachable from the console |
| `qnfo-containers-pilot` | container executor for Python and workspace jobs |
| `qnfo-doc-gate` | gate that keeps documents tied to code |
| `qnfo-infra` | shared infrastructure routes |
| `qnfo-fleet-dashboard` | operator console (fleet.qnfo.org): queue, decisions, prompted-recall questions, owner tasks |

## Phases

| Phase | What | State |
|---|---|---|
| P0 | Every live worker is classified, so new code lands on one side | done |
| P1 | A short default policy pack (the agreement every agent lane reads) extracted from the doctrine; QNFO keeps its owner directives as an overlay | open |
| P2 | Core tables move from QNFO's audit database into their own D1 database; QNFO tables stay; the kernel reads core tables only | open |
| P3 | Tenant settings (account, repository, hosts, model ladder, owner contact) come from configuration instead of constants | open |
| P4 | A second installation on a repository outside `qnfo-workers` proves the core runs without QNFO's applications | open |

Extraction order: `qnfo-deploy-guard` (work claims), `qnfo-fleet-control` (kernel), `qnfo-ai` (model router), `qnfo-ops` (canonical deploy), then the loops. Each extraction is a pull request with a test that the worker runs with no QNFO constant in its source.
