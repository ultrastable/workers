<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/modelport: the Models port and the Role runtime port

US-SPEC-14 section 3 names two ports the seed did not have. `index.js` defines both and ships an in-process reference runtime.

| Requirement | Status |
|---|---|
| Models: an alias (small, medium, large) resolved to an endpoint returning a completion and token counts | BUILT (`createModelPort`, `modelport.test.js`) |
| US-14-R10: deploy-time failure when reviewer and doer resolve to one family while two are available | BUILT (`deployCheck()`); a host calls it at deploy and refuses to ship on `ok: false` |
| US-14-R04: presence map only | BUILT: the port reads `env[name] === true` and never a value |
| Role runtime: one instance per manager or staff role | BUILT in process (`createRoleRuntime`): a store lease per role row, one run at a time, dispatch rows worked to done or failed |
| Role runtime on Durable Objects, container jobs or an agent engine | NOT COVERED: adapters, each needs a live account. They implement `instances`, `runRole`, `runDispatches` |
| Endpoints (edge inference binding, hosted model) | NOT COVERED here: passed in as functions; `core/router` holds the provider calls |

Owner role: operations. Trigger: a deploy, or a queued dispatch. Closing probe: `node --test core/modelport/modelport.test.js`.
