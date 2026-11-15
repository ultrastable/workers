<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/tenancy: tenant isolation

Implements `US-SPEC-10` section 7 (tenant isolation) and `US-10-R13`.

Levels: 1, a separate account per tenant; 2 (default), a separate database and worker per slug (`resourceNames`); 3, a shared database with the tenant id enforced by `scopedStore`. A control plane holds only the registry, the hourly aggregates tenants push (counts only) and the isolation probe results; it has no read path to tenant items.

```js
import { registerTenant, tenancySteps, localAccess, httpAccess, handle } from './core/tenancy/index.js';
// control plane: config.tenancy = { role: 'control' }; access is how one tenant's credentials reach another's canary
await runTick(db, { config, extraSteps: [...tenancySteps({ access: httpAccess({ fetch, env, tenants }) })] });
// tenant: config.tenancy = { role: 'tenant' }; push is the host's call to the control plane
await runTick(db, { config, extraSteps: [...tenancySteps({ push })] });
const res = await handle(request, { db, env, slug });   // tenant side: /tenancy/canary/<id>, bearer token by env name
```

Migration: `core/tenancy/migrations/0001_tenancy.sql`.

| Requirement | Status | Where |
|---|---|---|
| Levels 1 to 3, level 2 default | BUILT | `LEVELS`, `DEFAULT_LEVEL`, `resourceNames`, `scopedStore` |
| Control plane has no read path to tenant items; hourly aggregate | BUILT | `buildAggregate`, `receiveAggregate` (anything but known counts is refused), `silentTenants` |
| US-10-R13 daily isolation probe per tenant pair: canary in A, read with B's credentials, expect denial (zero rows at level 3), delete, record | BUILT | `isolationProbe`, `isolationSweep` |
| A mismatch is a severe outcome and a priority-0 item | BUILT | `tenancy_probes.severity`, item `ISOLATION-<a>-<b>` |
| A separate cloud account per tenant (level 1) created by the seed | NOT COVERED (needs an account-creating credential) | |
| Run against two live tenants | NOT COVERED: tested with in-memory databases and a fake HTTP path | |

Tests: `core/tenancy/tenancy.test.js`.
