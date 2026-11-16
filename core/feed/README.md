<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/feed: a changelog as RSS 2.0 and JSON Feed 1.1

`toRss`, `toJsonFeed` and `itemsFrom(changes, describe)` render any tenant's change records. The tenant owns `describe` (wording and links); core owns the format and escaping. Pure functions, no ports, no tables.

Spec: none yet (filed as a spec gap). Owner role: operations. Trigger: a tenant serves `/feed.xml` and `/feed.json`. Closing probe: `feed.test.js`. Status: BUILT.
