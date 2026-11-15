<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# adapters/docdb: document-database adapter

A document store has no SQL, so the store handle of US-SPEC-14 cannot run on it. `index.js` defines the small document port a driver must offer (create-only write, get, set, patch, add, indexed query, scan, transaction), a reference in-memory implementation of it, and the three tick steps the specification names, rewritten against that port.

| Requirement | Status |
|---|---|
| Each L1 table is a collection keyed by primary key | BUILT (`COLLECTIONS`, `importFromStore`) |
| Claim uniqueness by a create-only write keyed by item id (US-01-R02, US-01-T02) | BUILT (`docdb.test.js`) |
| Dispatch as an indexed query on (status, owner_role, priority) then a transactional claim | BUILT; a query with no declared index is refused |
| Reconcile, trust and dispatch rewritten, conformance re-run (US-01-T03, parity with `core/src/tick.js` on the same data) | BUILT |
| US-14-R11 claim correctness under contention | BUILT on the reference store (fifty concurrent claimers, five concurrent dispatchers) |
| The other five L1 steps (reap_claims, probe_gates, score_predictions, execute, check_plus_share) | NOT COVERED: not rewritten |
| A driver for a hosted document database | NOT COVERED: needs a live account; it has to implement the port in the header of `index.js` and pass `docdb.test.js` |

Owner role: operations. Trigger: a deployment that names a document store. Closing probe: `node --test adapters/docdb/docdb.test.js`.
