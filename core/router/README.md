<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/router: cost-aware model ladder

Implements the model ladder of `US-SPEC-09` (with the Models seam of US-SPEC-14). A role asks for a rung (`small`, `medium`, `large`) and optional capabilities (`tools`, `json`, `long-context`, `vision`); the router maps that to a provider and model from configuration, falls back in order, enforces spend caps, honors kill switches and records every call.

Ports: `db` (D1-style), `fetch` (injected), `now`, `config`, `env` (only the presence of each provider's key variable is checked; key values are used solely as a request header and are scrubbed from stored or returned errors).

```js
import { createRouter } from './router.js';
const router = createRouter({ db, fetch, now: Date.now, config, env });
await router.route({ role: 'doer', rung: 'medium', capabilities: ['tools'], item_id, kind: 'doer' });
await router.call({ ...same, messages: [...] });
await router.spend('day');
await router.setSwitch('all', true, 'drill');
// fetch-style: handle(request, { router }) serves GET /spend?period=, POST /route
```

Configuration: see `example-config.json` (generic `provider-a`/`provider-b`). Migration: `migrations/0001_router.sql` (`router_calls`, `router_switches`, `router_gate_records`).

## Requirement status

| Requirement | Status | Where |
|---|---|---|
| US-09-R01 per-loop on/off row | PLANNED | Router provides provider and global switches; per-loop rows belong to the tick |
| US-09-R02 global switch stops claims and leases | NOT COVERED | Claim service is another module; router honors `all` for paid calls |
| US-09-R03 bounded drill | PLANNED | `setSwitch` exists; no drill runner |
| US-09-R04 per-iteration bounds | PLANNED | Only `max_tokens` default is applied |
| US-09-R05 no paid call while a cap is breached | BUILT | hard cap refuses, files `router_gate_records` row |
| US-09-R06 never raise a cap or clear a breach by deletion | BUILT | Router never writes caps or deletes calls |
| US-09-R07 cap steers down, never ends task while free path exists | BUILT | soft cap steps down one rung; hard cap serves only free models |
| US-09-R08 capability first | BUILT | model `capabilities` list is the passed-canary set |
| US-09-R09 escalation on measured signal | PLANNED | Provider errors fall back; no rung escalation or retry bound |
| US-09-R10 cost/escalation/cache/tool-call metrics | BUILT (cost, tokens, latency, outcome) / PLANNED (rest) | `router_calls`, `spend()` |
| US-09-R11 model floor guard | PLANNED | |
| US-09-R12 decision-model agreement gate | PLANNED | `model_admission` table not built |
| US-09-R13 review and proposal in different families | BUILT | reviewer excludes doer families of the same `item_id`; refuses with `no_distinct_family` |
| US-09-R14 tier from budget | BUILT | `selectTier(budget, tiers)` |
| US-09-R15 loop breaker | NOT COVERED | |

Not built: L0 deterministic handlers, L1 cache, ensemble, distillation, draft-then-verify, persisted capability matrix.
