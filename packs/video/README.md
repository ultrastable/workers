<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# packs/video: short video publishing with provenance

Class B pack (`US-SPEC-21`). OFF until enabled; every publish passes `guard.send` on channel `video`.

| Piece | Does |
|---|---|
| `submitVideo` | runs `checkVideo` (length, asset hash, provenance, disclosure on synthetic media, fresh public claim sources, allowlisted https links), records a canonical provenance hash, queues once per asset hash |
| `publish` loop | `guard.send` per queued video; the channel port gets the file reference and provenance; below the act rung it waits as a decision card |
| `verify` loop | `fetchVideo` read-back: live and same provenance hash, else item `VIDEOVERIFY-<id>` |
| `metrics` loop | counts, views, removal detection (`VIDEOREMOVED-<id>`) |

Channel port: `publish({title, description, assetRef, assetSha256, durationS, provenance, provenanceHash}) -> {id, url}`, `fetchVideo(id) -> {state, provenanceHash?, views?, url?} | null`. Secret by name only: `VIDEO_CHANNEL_TOKEN`. Tests: `video.test.js`.
