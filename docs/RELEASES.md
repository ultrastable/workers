<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# Releases and the runtime pin

Instances (QNFO, a third party) pin this repository's runtime code by git tag. The tag is recorded as `runtime.ref` in the instance's `ultrastable.lock.json` (see `ultrastable/ultrastable` `docs/architecture/core-and-instances.md`). The pin is the same idea as a Terraform git source with `?ref=v1.2.0`.

- Tags are `vMAJOR.MINOR.PATCH`. A major bump ships a migration note in the release text.
- Cut one with the `release` workflow (manual dispatch, `version` input). It refuses a non-semver or existing tag, and refuses a commit without a green `test` check.
- `python tools/release.py --current X.Y.Z` proposes the next version from commit subjects.
- Closing probe: `gh release list` shows the tag, and an instance's `python3 -m foundation upstream check` passes with `runtime.ref` set to it.
