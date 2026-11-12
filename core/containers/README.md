<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/containers: container executor (US-SPEC-11)

`createContainers({ db, now, config, executors, secrets })` gives `submit` (validated, idempotent by key), `runNext` (claims with a lease, runs through an ordered executor list, records exit code and scrubbed output), `reap` (re-queues expired leases, fails jobs out of attempts), `get`, `stats`. Jobs are checked before any executor sees them: command length and allowlist, image allowlist, safe file paths and sizes, env names. A nonzero exit is a `failed` result and is not retried; an infrastructure failure (all executors throw or time out) is retried up to `max_attempts`.

Owner role: operations. Closing probe: `reap()` leaves no `running` row past its lease. Status: BUILT (`containers.test.js`). Container image and platform binding: NOT COVERED, need a live Cloudflare account (`ops/extraction-unblocked.json`); the executor adapters stay in `adapters/cloudflare/containers`.
