<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# packs/analytics: privacy-first page counts

Class A pack (`US-SPEC-21`): no outbound channel. `recordPageview({db, now, settings, request})` stores path (no query), referrer host and `utm_*` tags with a daily-rotating visitor hash (`sha256(salt|day|ip|ua)`); no IP, cookie or raw user agent. Bots, Do Not Track and Global Privacy Control are skipped.

| Loop | Does |
|---|---|
| `rollup` | idempotent daily totals per page and per source |
| `retention` | rolls up, then deletes raw events older than `raw_retention_days` (7) |
| `metrics` | views in 7 days, visitors today, raw event count |

`report({db, days})` gives views, top pages and top sources. Secret by name only: `ANALYTICS_SALT`. Tests: `analytics.test.js`.
