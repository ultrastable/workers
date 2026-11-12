<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/steward: the item ledger mirrored to every tracker (US-SPEC-08)

`mirror` pushes each changed item to every configured sink (no single route; a failing sink never blocks the others). `unplaced` lists open items missing on a sink, `stuck` lists mirrors that never succeeded, `rollup` counts items for the console, `steward` runs the cycle, records a `steward_runs` row and files one deduplicated item (`STW-<item>-<sink>`) per stuck mirror. Sinks are ports (`{ name, upsert }`); the GitHub and file sinks are in `adapters/github/steward.js`.

Owner role: operations. Trigger: every tick. Closing probe: `unplaced()` and `stuck()` are empty. Status: BUILT (`steward.test.js`). Pull-direction sync (tracker edits back into items): NOT COVERED, blocked on a conflict rule (see `ops/extraction-unblocked.json`).
