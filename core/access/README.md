<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/access: the access preflight

A request for the owner's help about access, a permission, a credential or an install is refused unless the system proved the capability missing on every route first. The rule lives in the database, so no module can skip it.

- `probe(ctx, capability, subject)` runs every route of a capability (`CAPABILITIES`: `github.app_installed`, `github.repo_permission`, `github.workflow_ran_ok`, `cloudflare.account_access`, `cloudflare.workers_deploy`, `cloudflare.git_connection`, `config.setting`, `secret.available`), records each route's result in `access_routes` and the newest result in `access_state`. A route answers present, absent (authoritative) or unknown (a 403, a network error). `missing` needs at least one absent and no present or unknown; an unreadable answer is never `missing`.
- `askOwner(ctx, { capability, subject, id, what, why_gated, default_in_effect, closing_probe })` probes fresh, and only when the state is `missing` writes the permit and the gate card, with every route and its result in `why_gated`. Otherwise nothing is filed and the refusal is recorded in `access_blocked_asks`.
- The trigger `access_permit_guard` refuses a permit without a fresh `missing` probe. The trigger `access_ask_guard` closes any gate card that reads as an access request and has no permit, records it, and, for an `env:` probe, files a blocked item that closes when the setting appears. Money, payment, legal, signing and destructive requests are not matched (interrupt gate).
- `step` is a tick step (`config.access.needs`), wired in `core/org`. `cli.mjs` runs the same probes in CI and lints files for ask text that contradicts the probe (`ask_phrases`, `lint_paths`).

Tenant-agnostic: a tenant lists its own needs and phrases in its own config. Owner role: operations. Closing probe: `core/access/access.test.js`, `core/access/cli.test.js`. Status: BUILT.
