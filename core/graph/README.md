<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/graph: topology and blast radius

Edges from in-repo imports (JS/TS and Python) plus declared edges; `blastRadius(ctx, changed)` returns everything that transitively depends on the change. `sources` is an ordered list of edge providers (tree API, local files, ...): a failing source is reported and the others still build the graph.

Owner role: project-manager. Trigger: ingest on each merge; query before each change. Closing probe: `blastRadius` of a known leaf lists its known importers. Status: BUILT (`graph.test.js`). Knowledge-graph (non-code) nodes and cross-service call discovery: NOT COVERED; declare them with `declare()`.
