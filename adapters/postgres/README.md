<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# adapters/postgres: dialect shim

`index.js` turns the core's SQLite-flavoured SQL into Postgres and wraps a client that has `query(text, params)` into the store handle of US-SPEC-14 (`prepare().bind().all()/first()/run()` with `meta.changes` and `meta.last_row_id`). No driver is imported; the client is a port.

| Requirement | Status |
|---|---|
| US-SPEC-14 section 4 dialect rules (`?` to `$n`, `INSERT OR IGNORE`, `datetime('now')` as UTC text, `AUTOINCREMENT`, `RETURNING id`) | BUILT (`postgres.test.js`) |
| US-14-R02 store handle shape | BUILT against a recording client |
| US-14-R06 time strings compare as text | BUILT (the shim writes `YYYY-MM-DD HH:MM:SS`, UTC) |
| US-14-R07, US-14-T01 the L1 tick suite over a live Postgres | NOT COVERED: no Postgres server or driver is available to the test run. Every statement in `core/src/tick.js` is translated and checked for parameter count, which is the nearest proof without a server |
| US-14-R11 claim correctness under contention on Postgres | NOT COVERED: needs a live server |

Owner role: operations. Trigger: a deployment that names a Postgres store. Closing probe: `node --test adapters/postgres/postgres.test.js`.
