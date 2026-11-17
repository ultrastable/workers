<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/deploygate: deploy from CI with no stored secret

`createGate({ fetch, now, config: { rules, accountId, token, issuer? } })` returns `{ handle(req) }`. `worker.js` is the Worker entry (bindings `ALLOW`, `CF_ACCOUNT_ID`, `CF_DEPLOY_TOKEN`).

A CI run requests its OIDC identity token with the gateway origin as audience and `POST /deploy`s the built bundle (`script`, `worker.js` form fields). The gateway verifies the RS256 signature against the issuer's published keys, checks issuer, audience and expiry, then requires a rule `{ repo, refs, script }` that matches the token's repository and ref. Only then does it upload the module (keeping existing bindings) and read the bytes back; a failed upload or a read-back mismatch is a 502, never "deployed". The account credential exists only as the gateway's own secret binding; no repository stores a secret. Tenants add a rule in configuration; no tenant name appears in this code.

Tests: `index.test.js` (valid deploy; no/forged/expired/wrong-audience token; wrong repo, ref or script; failed upload and read-back mismatch).
