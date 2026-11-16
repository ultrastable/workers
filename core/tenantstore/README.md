<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/tenantstore: sandboxed, budget-capped tenant data

Implements US-SPEC-25 (tenant storage). One private store per tenant behind a `SqlPort`; every statement is metered; a spent budget refuses work instead of billing.

| Requirement | Status | Where |
|---|---|---|
| TS-1 one private store per tenant, reached only through its own handle | BUILT | `store.js`, `adapters/cloudflare/src/tenant-do.js` (`tenantStub` validates ids) |
| TS-2 day and month budgets for reads, writes, requests, vector dimensions, refused past the cap | BUILT | `budget.js`, test "write budget is a hard cap" |
| TS-3 scans refused (per-query read cap), indexed reads stay cheap | BUILT | `store.js`, test "full-table scan" |
| TS-4 rollups maintained on write, read as one row | BUILT | `rollup.js` |
| TS-5 vector search in the tenant store, int8, capped by `maxVectors` | BUILT | `vector.js` |
| TS-6 hot reads from a cache port, stale value served when the budget is spent | BUILT | `store.js` `cached` |
| TS-7 spend probe and worst-case bound from list prices | BUILT (estimates, see `prices.json` `as_of`) | `spend.js` |
| TS-8 Durable Object adapter | BUILT against a fake `ctx.storage.sql`; NOT deployed to a real account | `adapters/cloudflare/src/tenant-do.js` |
| TS-9 spill to a per-tenant Vectorize index past `maxVectors` | PLANNED | none yet |
| TS-10 cross-check of self-metered usage against Cloudflare GraphQL analytics | PLANNED | none yet |

Not modelled: Durable Object duration (GB-s) charges and request-unit rounding; the probe is an estimate, never a bill.

Wrangler (Cloudflare adapter): `durable_objects.bindings = [{ name = "TENANT", class_name = "TenantDO" }]` and `migrations = [{ tag = "v1", new_sqlite_classes = ["TenantDO"] }]`. Per-tenant budgets go in the `TENANT_BUDGETS` variable as JSON keyed by tenant id.

Test: `node --test --no-warnings core/tenantstore/tenantstore.test.js`.
