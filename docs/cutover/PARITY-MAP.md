<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# Parity map: QNFO worker to ultrastable/workers module

Source: [extraction/INVENTORY.md](../../extraction/INVENTORY.md) and `extraction/boundary.json`. Order is the cutover order for stage 4. "Parity gate" is the unit's proof; "Gap" points to [SHIMS.md](SHIMS.md) or [GAPS.md](GAPS.md).

| Order | QNFO worker | Module here | Status | Parity gate | Gap |
|---:|---|---|---|---|---|
| 1 | deploy-guard | `core/claims` | BUILT | claims tests; no duplicate live claim; contract check `claims-closed` | S-1 secret lease |
| 2 | ai | `core/router` | BUILT | router tests; ladder from instance file | S-2 QNFO model ladder |
| 3 | ai-calibration | `core/router/calibration.js` | BUILT | calibration tests; last healthy provider never disabled | none |
| 4 | fleet-control | `core/kernel`, `core/src/tick.js` | BUILT (tick, metrics, lifecycle, failure modes) | one scored tick cycle on the new side | S-3 charter, portfolio, research steps |
| 5 | ops | `core/deploy`, `adapters/*/deployer.js` | BUILT change path | canary revert decision test; deploy probes | G-1 ops agent PLANNED |
| 6 | code-orchestrator | `core/codeloop`, `core/runner`, `adapters/github/steward.js` | BUILT | merge gate tests | none |
| 7 | github-steward | `adapters/github` | BUILT push direction | mirror and hygiene tests | G-2 pull-direction sync |
| 8 | intent-orchestrator | `core/intent` | BUILT | submit outcomes tested | none |
| 9 | cloud-ops | `core/tasks` | BUILT | queue and owner-step watch tests | none |
| 10 | observability | `core/observe` | BUILT | ingest, p95, scrub tests | S-4 QNFO scorer chains |
| 11 | memory-mcp | `core/graph` | BUILT | blast radius tests | none |
| 12 | tools-mcp | `adapters/mcp` | BUILT | two transports tested | none |
| 13 | ai-yield | `core/yield` | BUILT | ledger tests | S-5 owner-code login page |
| 14 | waste-agent | `core/yield` | BUILT | W-ERR, W-RATE, W-META, W-YIELD tests | none |
| 15 | doc-gate | `core/docgate` | BUILT | store port tests | none |
| 16 | infra | `adapters/shared/routes.js` | BUILT | route table tests; contract check `unauth-closed` | none |
| 17 | agents | `adapters/cloudflare/agents` | BUILT SDK-free | runtime tests | G-3 Durable Object wrapper |
| 18 | containers-pilot | `adapters/cloudflare/containers` | BUILT executor | executor tests | G-4 image and binding |
| 19 | fleet-dashboard | `core/src/console.js` (generic console) | SUPERSEDED | `console` contract check | S-6 QNFO-styled views |

## Non-worker units

| QNFO unit | Disposition |
|---|---|
| 10 core scripts | in `tools/` and `extraction/product_boundary.mjs` |
| 7 core workflows | manual-trigger templates in `adapters/github/workflows/`; QNFO keeps its scheduled copies until stage 8, none above weekly are added |
| ~550 one-off scripts, `migrations/` (2221 files) | not carried; 22 core tables re-derived per module (stage 3 copies data) |
| 12 app workers, 8 personal workers | stay with QNFO as the demo instance's own apps; they call the core through the route table, not through code imports |
| `product/` claims feed | G-5 needs the product's own host (issue #10) |

## Rule

A row moves to "cut over" only when its parity gate passes on both sides. A new contract check is added to `parity-contract.json` in the same change that moves the unit.
