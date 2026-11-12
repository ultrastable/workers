<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# packs/cloud: Cloudflare and Google Cloud through core/deploy

Class D pack (`US-SPEC-21`): every deploy leaves through `guard.send` with `viaDeploy: true`, and the guard's port calls `core/deploy` (lock, version check, probes, rollback). Class ceiling is `delegated`; below that a deploy waits as a decision card.

```js
const deploys = { cloudflare: createDeploy({ db, deployer: cloudflareDeployer, ... }), gcp: createDeploy({ db, deployer: gcpDeployer, ... }) };
createPacks({ db, config: { packs: { cloud: { units: [{ provider: 'cloudflare', unit: 'web' }], deploys } } },
  channels: { cloud: guardPort({ db, deploys, artifacts }) } });
await requestDeploy({ db, settings, provider: 'cloudflare', unit: 'web', version: 'v2', by: 'agent' });
```

| Piece | Does |
|---|---|
| `requestDeploy` | queues once per provider, unit and version; refuses unlisted units, unconfigured providers, bad names |
| `apply` loop | `guard.send`; the result (`deployed`, `reverted`, `failed`) and the `deploy_ledger` id land on the request |
| `inventory` loop | `deploy.reconcile(unit)` per listed unit; an out-of-path change files `CLOUDUNLOGGED-*` |
| `metrics` loop | deployed, reverted, failed, unlogged counts |

Secrets by name only: `CLOUDFLARE_API_TOKEN`, `GCP_SERVICE_ACCOUNT_KEY`. Tests: `cloud.test.js`.
