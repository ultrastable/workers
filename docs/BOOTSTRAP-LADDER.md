<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE. -->

# Bootstrap ladder: no single point of failure

Owner directive 2026-11-11: a non-coder cannot be asked to mint an API token; a bootstrap that needs one is a failed bootstrap, and there must always be a workaround.

## Failure record

| Date | What failed | Why | Owner |
|---|---|---|---|
| 2026-11-11 | Self-hosting bootstrap stopped waiting for a scoped Cloudflare API token and a pasted GitHub secret | The only route required a person to create a token (a security setting an agent may not do) and paste a credential. A non-coder will not do that. | issue filed with this document |

## The ladder (each rung is tried automatically; the system reports which it used)

1. **Connect, do not paste.** The person clicks Allow once on Cloudflare's own screens: sign in with the connect-GitHub flow (Workers Builds) or the browser login that Wrangler uses. No token is created or copied by a person. BUILT in `bootstrap/ladder.py` (Wrangler OAuth session, `--interactive` starts `wrangler login`); bootstrap tries it first and records why it failed. PLANNED: the launcher shows this as one button.
2. **Temporary account, then claim.** Door A creates a preview with no account, the person claims it with one sign-in. BUILT (workers#56). Limits: no scheduled trigger, 1 database.
3. **Heartbeat without a token.** The Worker ticks itself with a Durable Object alarm (issue #20), so the running system needs no cron and no outside credential. BUILT for the preview Worker (workers#83) and for the real Worker (`adapters/cloudflare/src/heartbeat.js`); bootstrap redeploys in alarm mode automatically when the account refuses cron triggers.
4. **Scoped token supplied by the owner.** The expert path (`bootstrap-apply` with secrets). BUILT, last resort.

A rung that fails records why and the next rung starts. A bootstrap that ends without a running system and without a recorded reason for each rung is a defect (US-SPEC-24 closed loops).

## Identity-bound steps that remain (stated once)

Signing in to Cloudflare and accepting its terms are the person's own acts. The system makes each a single click with the exact screen described, and does everything before and after.
