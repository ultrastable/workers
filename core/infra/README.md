<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/infra: shared routes (US-SPEC-14)

`createInfra({ routes, env, db, now, config, checks })` is the one route table every host uses: prefix match, optional method list, bearer auth read from `env` at request time (unset token = closed 503), fixed-window rate limit per route and caller, body cap, handler errors as 500 without a stack, plus built-in `GET /health` and `GET /health/deep` (named checks and stale heartbeats). Helpers: `heartbeat` / `staleHeartbeats` (a scheduled job silent for twice its period is stale), `capRows`, `secretsPresent` (names only), `safeEqual`.

Owner role: operations. Closing probe: `/health/deep` answers 200. Status: BUILT (`infra.test.js`). The older `adapters/shared/routes.js` stays for hosts that do not need the database-backed parts.
