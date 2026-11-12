<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/waste: finds spend that produces nothing (US-SPEC-09)

`wasteRun` runs the call-ledger rules of `core/yield` (W-ERR, W-RATE, W-META, W-YIELD) and adds the gauge rules W-BACKLOG and W-STALL over ports `ctx.gauges = { name: { read, kind, limit } }` (limits also from `config.gauge_limits`). Each finding opens one item (`WST-...`), re-opens on recurrence and closes after `clean_runs_to_close` clean runs. An unreadable gauge never files. `report` ranks the top spenders with their wasted share. Model-route probing is `core/router/calibration.js`; yield accounting is `core/yield`.

Owner role: operations. Trigger: every tick. Closing probe: no open `WST-` or `YLD-` item older than its rule's clean window. Status: BUILT (`waste.test.js`). Needs the `core/yield` migrations.
