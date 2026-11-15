<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/console-l3: operator console and product dashboard

| Requirement | Status |
|---|---|
| US-13-R01 raw state as JSON and a health route (US-13-T01) | BUILT (`index.js`, `dashboard.js`) |
| Dashboard routes `/`, `/api/state`, `/api/refresh`, `/api/integration`, `/api/loop`, `/health` | BUILT (`dashboard.js`, `dashboard.test.js`) |
| US-13-R02 digest, page and JSON from one state | BUILT |
| US-13-R03, R04, R05 report cards: evidence, limits, a fall of 0.5 files an item (US-13-T02, T05) | BUILT (`index.js`, `console-l3.test.js`) |
| US-13-R06 objective function: propose, never adopt | BUILT |
| US-13-R11 step-budget breach procedure (US-13-T04) | BUILT (`sweepStepBudgets`; step runs come from `core/sla`) |
| US-13-R13 probe targets checked against routing | BUILT (`classifyProbes`): the caller passes the routes and the probe results |
| 24-hour request and error panels from platform analytics, per-worker run ledger | NOT COVERED: needs a live account's analytics |

Ports: `db`, `now`, `config`. Owner role: operations. Closing probe: `node --test core/console-l3/console-l3.test.js core/console-l3/dashboard.test.js`.
