<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/agents: agent runtime (US-SPEC-11)

`createAgents({ db, router, now, config, hooks })` gives `define(name, { system, tools })`, `turn`, `decide`, `expire`, `compact`. Tools are functions or `{ run, approval, description }`; a tool with `approval: true` stops the turn with `pending_approval` and runs only through `decide(id, true)` before its expiry (`approval_ttl_minutes`). `hooks.before` can veto (fail closed), `hooks.after` observes. `compact` folds old messages into one summary. Step cap, router refusals and unknown agents are surfaced, never swallowed.

Owner role: operations. Closing probe: `agents_approvals` has no `pending` row past `expires_ms` (call `expire()` each tick). Status: BUILT (`agents.test.js`). Durable Object / Agents SDK wrapper: NOT COVERED, needs a live Cloudflare account (`ops/extraction-unblocked.json`). The SDK-free adapter runtime stays in `adapters/cloudflare/agents`.
