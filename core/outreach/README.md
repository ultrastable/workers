<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/outreach: approval-gated outreach outbox for automated senders

Tenants call `submit` with an intent; a named human calls `approve`; `dispatch` sends only approved, unsuppressed intents within caps. With no `transport` it is a dry run that records what would have been sent. The sender identity (`config.sender`: name, postal, reply_to) and the disclosure `config.footer` are required and appended to every message; an `https` evidence URL is required per intent. `suppress` is immediate and permanent and blocks pending intents. Tables: `outreach_intents`, `outreach_suppressed`, `outreach_log`.

Spec: none yet (filed as a spec gap). Owner role: operations. Trigger: tenant submits an intent. Closing probe: `outreach.test.js`. Status: BUILT.
