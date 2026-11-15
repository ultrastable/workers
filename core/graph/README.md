<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/graph: topology and blast radius

Edges from in-repo imports (JS/TS and Python) plus declared edges; `blastRadius(ctx, changed)` returns everything that transitively depends on the change. `sources` is an ordered list of edge providers (tree API, local files, ...): a failing source is reported and the others still build the graph.

Owner role: project-manager. Trigger: ingest on each merge; query before each change. Closing probe: `blastRadius` of a known leaf lists its known importers. Status: BUILT (`graph.test.js`). Knowledge-graph (non-code) nodes and cross-service call discovery: NOT COVERED; declare them with `declare()`.

## Wiring graph (`wiring.js`, US-SPEC-12 Part B)

`sweep` reads each worker's crons, routes, queue consumers and bindings from a deployment metadata port and stores the reading (`migrations/0002_wiring.sql`); `analyze` labels islands, sinks, sources and unresolved targets, computes directed density and the drift counts against a registry port, joins each table's writers with its readers and writes service and data-flow edges into the same edge table blast radius reads; `census` separates idle from unmeasured. Tests: `wiring.test.js`.

| ID | Status | Where |
|---|---|---|
| US-12-R09 graph read from deployment metadata | BUILT against a `metadata` port; the adapter that calls a real platform is NOT COVERED | `sweep` |
| US-12-R10 errored worker listed under errors, excluded from counts | BUILT | `sweep` |
| US-12-R11 islands, sinks, sources, unresolved, three drift counts | BUILT | `analyzeGraph`, `analyze`; T05 |
| US-12-R12 producer-without-consumer tables | BUILT. Table access comes from the metadata port's declared lists and from SQL found in script text; SQL assembled at run time is not seen | `extractTableAccess`, `producerConsumer` |
| Data-flow edges | BUILT | `analyze` |
| US-12-R13 no retirement before the roster includes the member | BUILT | `census` |
| US-12-R14 probe and calibration traffic is not external usage | BUILT | `externalUsage`, `census` |

