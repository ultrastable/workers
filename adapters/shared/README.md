<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# adapters/shared: route table (infra)

`routes.js`: one route table (prefix to handler, optional bearer-token auth that fails closed when the token is unset, constant-time compare, handler errors become 500 without a stack). Every host (Worker, Node, Cloud Run) mounts the same table, so a route is defined once. Replaces per-host route files from the source fleet.

Owner role: operations. Trigger: any new route. Closing probe: `list()` shows every route and which require auth. Status: BUILT (`routes.test.js`).
