<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/ownerlink: every owner action is one link (OWNERLINK-1)

Whatever only the owner can do is a row in `ownerlink_actions` with exactly one link, listed on `/owner` (JSON at `/api/owner/actions`). The owner signs in once (GitHub App session, or Cloudflare Access JWT) and each action is one button; a standards-based flow and its callback do the rest and store results in the vault.

- Flows: `mastodon.js` (dynamic app registration, authorize, callback, `MASTODON_TOKEN`; signup link beside the button), `atproto.js` (Bluesky: PKCE, PAR, DPoP, `BLUESKY_OAUTH`; `createBlueskyClient().post()` for the promoter), `prs.js` (open PRs waiting on a human reviewer, link to the review page), GitHub App (the existing `/console/github/connect`).
- Preflight hook: `askOwner` (core/access) files the link with the card. With no flow the ask is refused (`no_owner_link`) and becomes a staff item `OWNERLINK-<card>`. The trigger `ownerlink_card_guard` closes any permitted card that has no link.
- Config (`config.ownerlink`): `origin`, `mastodon.instance`, `bluesky.service`, `signup`, `prs: { repos, labels, owner_login }`, `flows`.

Closing probe: `core/ownerlink/ownerlink.test.js`. Status: BUILT.
