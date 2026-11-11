<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# adapters/cloudflare/agents: agent runtime

`runtime.js`: bounded model-and-tool loop with database memory (`agents_messages`), over the router, no SDK vendored. An SDK-hosted agent (Durable Object) can wrap `turn()`; the same code runs on any host with a D1-shaped db.

Owner role: staff. Trigger: console or MCP request. Closing probe: a turn returns a final answer or an explicit refusal within `max_steps`. Status: BUILT (`runtime.test.js`). The Durable Object wrapper itself: NOT COVERED (needs a Cloudflare account to prove).
