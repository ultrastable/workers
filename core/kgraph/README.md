<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/kgraph: a knowledge graph that generates work

A typed graph of nodes and edges, each fact carrying provenance (`source`, `url`, `at`), kept in a store port (`get`/`put`; a KV namespace fits). Tenant-agnostic: kinds (`problem`, `solution`, `agency`, ...), relations and gap rules are the tenant's data.

It drives generation, not only storage. `gaps(rules)` lists nodes that lack an expected confirmed relation; `questions(rules)` turns each gap into a question a loop can work on, worded by the tenant. `propose` records an unconfirmed edge (a lead) that never fills a gap; `confirm` promotes it and requires provenance. `neighbors` with `dir: 'in'` gives backlinks, `reach` walks outward over chosen relations, `validate` flags dangling edges and confirmed edges with no provenance.

Not covered: a store larger than one value (the graph is one JSON blob under a single key, fine to a few thousand edges; a D1 backend is the next step), and any use of a model. `core/graph` is the separate code-topology graph.

Owner role: knowledge. Trigger: a tenant ingests facts or runs its question loop. Closing probe: `kgraph.test.js`. Status: BUILT.
