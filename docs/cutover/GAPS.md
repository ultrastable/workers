<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# Gaps: identity-bound or access-blocked steps

Each gap has a reason, a workaround that lets the stage proceed, and a closing probe. None is a sign-off; the stage advances on its gate.

| ID | Step | Reason | Workaround in effect | Closing probe |
|---|---|---|---|---|
| X-1 | Real values for the demo instance file (account id, routes, owner contact, repository, model ladder) | This session cannot read the QNFO repository (extraction lesson 1). A marked placeholder template is in `docs/cutover/instance.demo.template.json` | The QNFO-side loop copies the template to its private config and fills it; until then the strict probe fails by design | `node tools/instance_config.mjs --file <filled file> --strict` exits 0 (it exits 1 on the template) |
| X-2 | Cloudflare account actions (shadow deploy, route moves, D1 export) | Needs the account's deploy token binding; minting a new one is owner-only | Use the existing deploy bindings through canonical deploy (or Workers API); no new token is requested | shadow Worker answers `/health` |
| X-3 | Replacing code inside the QNFO repository | This session has no push access there and must not touch it | Stage 7 runs as a PR opened by the QNFO fleet's own code-orchestrator lane from a tag of this repository | replacing PR merged and full parity contract passes |
| X-4 | Org avatar, public profile, anything public | Repositories stay private | none needed | none |
