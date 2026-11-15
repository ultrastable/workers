<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# packs/drafts: plan, technical-description and legal-style drafts, draft-only

Class C pack (`US-SPEC-21`): no outbound loop, and the guard refuses any send from it (`class_c_never_sends`). `createDraft`/`reviseDraft` run `checkDraft` (kind sections, no secret values, no claim of being final, advice or already used), prepend the banner and store every version with its hash. `markTaken` records that a person took a draft elsewhere; the pack never marks one used itself.

| Loop | Does |
|---|---|
| `stale` | files item `DRAFTSTALE-<id>` for a draft untouched `stale_days` (14) |
| `metrics` | open, stale and recent-version counts |

Tests: `drafts.test.js`.
