<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# Gaps: identity-bound or access-blocked steps

Each gap has a reason, a workaround that lets the stage proceed, and a closing probe. None is a sign-off; the stage advances on its gate.

| ID | Step | Reason | Workaround in effect | Closing probe |
|---|---|---|---|---|
| X-1 | Read the QNFO repository's live non-secret settings to author the instance file | This repository's session cannot read the QNFO repository (extraction lesson 1) | The instance file is authored by the QNFO deployment's own agents from its config; this repository ships only the schema, example and validator | `instance_config.mjs --file <real file>` exits 0 in the QNFO deployment |
| X-2 | Cloudflare account actions (shadow deploy, route moves, D1 export) | Needs the account's deploy token binding; minting a new one is owner-only | Use the existing deploy bindings through canonical deploy (or Workers API); no new token is requested | shadow Worker answers `/health` |
| X-3 | Replacing code inside the QNFO repository | This session has no push access there and must not touch it | Stage 7 runs as a PR opened by the QNFO fleet's own code-orchestrator lane from a tag of this repository | replacing PR merged and full parity contract passes |
| X-4 | Org avatar, public profile, anything public | Repositories stay private | none needed | none |
