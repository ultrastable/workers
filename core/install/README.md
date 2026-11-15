<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/install: one-command install

Implements `US-SPEC-10` section 7 (one-command install) and `US-10-R14`. The command is `node tools/install.mjs` (also `node tools/us.mjs install`).

`install(args, ports, opts)` holds the order, the checks and the exit codes; everything that touches the world is a port. Steps: preconditions, bundle (SHA-256 of bundle and migrations against the manifest, Ed25519 signature of the manifest when a public key is configured; a mismatch is exit 3 and nothing is applied), bootstrap, provision, connectors (presence only; an absent value becomes a gate card), deploy (health answers 503 until the first tick), first tick, register. Every step after the bundle has a probe and runs only when the probe fails, so the same command resumes a failed install and upgrades a tenant.

| Requirement | Status | Where |
|---|---|---|
| US-10-R14 verify the bundle digest before applying, stop on mismatch (exit 3) | BUILT | `verifyBundle`, `install`; `tools/install.mjs` |
| Signed bundle | BUILT: `tools/release_bundle.mjs --sign-key-env` writes `manifest.sig`, `verifySignature` checks it. No release has been signed yet: the signing key is the owner's to create | `verifySignature` |
| Re-running performs only the steps whose probes fail | BUILT | `install` |
| Provision through the adapter | BUILT against a fake of the platform API | `adapters/cloudflare/install-adapter.js` |
| Missing connector values become gate cards | BUILT | `connectorCard` |
| Run against a real account | NOT COVERED: `--apply` has not been run on a live account | |

Tests: `core/install/install.test.js`, `tools/install.test.mjs`, `adapters/cloudflare/src/install-adapter.test.js`.
