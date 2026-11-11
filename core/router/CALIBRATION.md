<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# router calibration

`core/router/calibration.js`: probes every provider and rung through the router with fixed probes (`echo-json`, `nonempty`), records `router_calibration`, switches a provider off after `fail_streak_off` failures and back on after `pass_streak_on` passes, filing and closing item `CAL-<provider>`. Switched-off providers are still probed so they can recover. The last healthy route is never switched off.

Owner role: operations. Trigger: weekly tick or manual. Closing probe: a recovered provider has its switch cleared and its item done. Status: BUILT (`calibration.test.js`). Stress tests and per-model latency percentiles: NOT COVERED.
