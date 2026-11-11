<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# adapters/cloudflare/containers: executor

`executor.js`: validated, bounded jobs on an ordered list of executors (platform container binding first, `httpExecutor` runner second); scrubs secrets, enforces timeout and output limits, reports every attempt.

Owner role: operations. Trigger: runner or tasks request a job. Closing probe: `execute` returns `ok` or an explicit refusal with attempts. Status: BUILT (`executor.test.js`). The container image and binding configuration: NOT COVERED.
