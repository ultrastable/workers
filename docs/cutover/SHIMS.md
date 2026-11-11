<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# Shims and compatibility list

A shim keeps something QNFO depends on working until a generic equivalent exists. Shims live in the QNFO instance overlay (the instance repository's private config and worker glue), never in this repository's shared code. Each has an owner role, an exit and a closing probe. Source for the open items: issue #93 and its closing comment.

| ID | QNFO dependency | Why no generic equivalent yet | Shim | Exit | Closing probe |
|---|---|---|---|---|---|
| S-1 | Secret lease shared by every agent lane (deploy-guard) | `core/claims` covers work claims; the lease needs a live secret store | Overlay route to the old lease endpoint, behind the route table | Generic lease over Workers secrets bindings | no calls to the old endpoint for 7 days |
| S-2 | QNFO model ladder and provider keys | Ladder is data; keys are the owner's | Instance file `model_ladder` plus binding names | none: stays configuration | validator passes |
| S-3 | Charter, portfolio and research-specific tick steps | QNFO-only by design (inventory) | Overlay steps registered into the generic tick | Stay in the overlay permanently | tick row lists overlay steps |
| S-4 | QNFO scorer chains in observability | QNFO-only by design | Overlay scorers on the `core/observe` port | Stay in the overlay | scorer output present |
| S-5 | Owner-code login page of ai-yield | not extracted; console is the generic surface | Keep the old page serving until console login covers it | Console login | route has zero hits for 7 days |
| S-6 | QNFO-styled dashboard views | superseded by `/console` | Redirect old dashboard host to the new console | Retire after 14 quiet days | redirect hit count is zero |
| S-7 | The 12 app workers and 8 personal workers | not product | Keep in QNFO deployment; reach core over HTTP routes only | none | no source import from core |

## Open items from issue #93

| ID | Item | Blocker | Workaround | Closing probe |
|---|---|---|---|---|
| G-1 | Server-side ops agent that drives `core/deploy` | not yet written | Old ops worker serves deploys until it is; stage 5 for this unit waits | agent opens a deploy item and the change path runs it in a test |
| G-2 | Pull-direction GitHub sync | needs QNFO sources or a live account | old steward keeps it | test for pull sync passes |
| G-3 | Durable Object wrapper for the agents runtime | needs a live Cloudflare account | old agents worker keeps it | wrapper deployed and probed |
| G-4 | Container image and binding | needs a live account | old containers-pilot keeps it | image runs a job |
| G-5 | Product claims feed | needs the product's own host (issue #10) | static claims file | feed answers on its host |
