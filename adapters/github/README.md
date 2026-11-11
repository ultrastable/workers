<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# adapters/github: issue steward and merge host

`steward.js`: mirrors items to every sink (`githubSink` REST issues, `fileSink` plain files; a failing sink never blocks the other and is retried), flags items missing owner role, done check or closing probe, and provides `githubMergeHost` for `core/codeloop`. Token by env name only.

Owner role: operations. Trigger: every tick (bounded to 50 items). Closing probe: `steward_mirror` has no row with `last_error` older than two sweeps; `flagged` is empty. Status: BUILT (`steward.test.js`). Pull-direction sync (GitHub edits back into items), labels and comment mirroring: NOT COVERED.
