<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/fleet: the fleet runtime

Schedulers start work, an executor does it and records it, and a dead-man check notices a scheduled slot with no record. Written to US-SPEC-11. Generic: no tenant names, no platform imports. Nothing here is RUNNING: no production use.

```js
import * as fleet from './index.js';
const ctx = { db, now: () => Date.now(), config: { worker: 'fleet', allowed_models: [{ id: 'small', cost: 1 }] }, fetch, ai, deployed, claims };
ctx.executor = m => fleet.execute(ctx, m);          // or a post to another worker's /fleet/execute
await fleet.step(ctx);                              // dispatch due rows, reap stale runs, dead-man check, reconcile when due
```

Ports: `db` (D1-style), `now()`, `config`, optional `fetch`, `ai({model, prompt, max_tokens})`, `bindings` (named databases for sql tasks), `executor(msg)`, `deployed.list()` (platform metadata, from an adapter), `claims` (the core/claims module), `authorize(request)`. Migration: `migrations/0001_fleet.sql` (tables `fleet_*`). Tests: `fleet.test.js`.

## Requirements

| ID | Status | Where |
|---|---|---|
| US-11-R01 worker contract (seven parts) | BUILT | `contractGaps`, `register` (secret names only), `health` |
| US-11-R02 registry is the census authority; deployed state reconciled on a schedule | BUILT against a `deployed.list()` port; the adapter that reads a real platform is NOT COVERED | `reconcile`, `step` |
| US-11-R03 next_fire and last_fired advance whether or not dispatch succeeded | BUILT | `dispatch`; T02 |
| US-11-R04 a schedule change is a row write | BUILT | `fleet_crons`, `setCron` |
| US-11-R05 unknown task types rejected; a run record for every execution | BUILT | `execute`; T03 |
| US-11-R06 envelopes validated before writing; rejects stored with their error | BUILT | `validateEnvelope`, `recordEvent` |
| US-11-R07 accounting invariant per batch, as a gate | BUILT | `recordBatch`, `drain`, `batchGate` |
| US-11-R08 dead-man check from declared cron expressions | BUILT | `deadman`, `expectedSlots`; T04 |
| US-11-R09 single-path failure distinguished from a stop | BUILT | `deadman` (alert kinds, priorities, per-scheduler reliability) |
| US-11-R10 one acting firing per slot under a work claim | BUILT | `fireOnce`; T05 |
| US-11-R11 overlap guard and reaper for stale queued rows | BUILT | `dispatch`, `reapStale` |
| US-11-R12 collisions per minute measured | BUILT (measurement); automatic staggering is NOT COVERED | `collisions` |
| US-11-R13 monitor hosted outside the writer of its probe table | NOT COVERED here; the detector is in core/remediation (`externalLiveness`) | |
| Eleven-column run ledger | BUILT | `fleet_runs` |
| Event-triggered scheduling | BUILT | `setTrigger`, `emit` |
| Hot standby | PLANNED: needs two deployed schedulers on a live account and a measured failover | |
| US-11-T01 next_fire('*/10 * * * *', 12:03) = 12:10 | BUILT | `nextFire` |

Limits: cron is five fields in UTC with the term forms of the spec (`*`, `*/n`, `a-b`, a literal, comma lists); names such as MON are not accepted. The `ai` task calls whatever gateway port it is given; cost is what the port reports.
