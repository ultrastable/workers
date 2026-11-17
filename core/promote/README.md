---
consumer: tools/boundary.json
---
<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/promote: autonomous promotion and reach

Tenant-agnostic. A tenant passes entries it already described; the engine posts them, measures referrals and re-weights channels. Status: BUILT unless marked.

| Piece | Status |
|---|---|
| `run`: compose, label as automated, idempotent, per-channel daily cap, own-origin links only | BUILT |
| Channels: IndexNow (public derived key, `indexnowKey`), Mastodon (`MASTODON_TOKEN`, base URL in config), Bluesky (`BLUESKY_IDENTIFIER`, `BLUESKY_APP_PASSWORD`); a channel without credentials is skipped | BUILT |
| Kill switch: `config.promote.halt` or `HALT=1` | BUILT |
| `tune`: weight = referrals per post with prior, floor 0.1; `run` orders channels and scales caps by weight | BUILT |
| `snapshot` / `evaluate`: reach targets as metrics, breaches returned for the tenant loop to file | BUILT |
| `ideaToItem`: an issue labelled `idea` becomes an `agent-ready` item with done check and probe | BUILT; the label-triggered workflow is a protected-path change, filed separately |
| Feed (`core/feed`), sitemap and JSON-LD stay tenant-side | existing |
| Open-data deposit with DOI (Zenodo, Hugging Face) | PLANNED (needs a deposit token) |
| Citation and backlink discovery (OpenAlex, Crossref events) feeding `snapshot` | PLANNED |

Secrets are read by name from `env`, never stored or logged. Tables: `promote_posts`, `promote_metrics`, `promote_weights`.
