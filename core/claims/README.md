<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/claims

Work claims, fences, secret lease, deploy lock and reconciliation hooks, written to US-SPEC-08 (primary), with US-SPEC-07 (control-plane claims), US-SPEC-09 (kill switch) and US-SPEC-14 (ports). Generic: no tenant names, no platform imports.

## Use

```js
import { acquire, heartbeat, release, check, reapExpired, reconcile, handle } from './index.js';
const ctx = { db, now: () => Date.now(), config: { claim_ttl_minutes: 120, lease_ttl_minutes: 2 },
              killSwitch: async () => false, authorize: async req => true };
const claim = await acquire(ctx, { path: 'src/app.js', holder: 'agent-1', intent: 'fix login' });
// claim.token (shown once), claim.fence; the protected resource calls check(ctx, {path, token, fence}) before each write.
```

Ports: `db` (D1-style), `now()` (ms, Date or `YYYY-MM-DD HH:MM:SS`), `config`, optional `killSwitch()` and `authorize(request)`. `handle(request, ctx)` routes `/work-lock|/deploy-lock|/secret-lock` + `acquire|heartbeat|release|check` (POST) and `status` (GET); POST is refused with 401 unless `ctx.authorize` exists or `config.allow_unauthenticated` is true. Config: `claim_ttl_minutes` (120), `lease_ttl_minutes` (2), `deploy_ttl_minutes` (15), `max_ttl_minutes` (240), `rework_threshold` (3), `escalation_role`.

Migration: `migrations/0001_claims.sql` (tables `claims_*`; a partial unique index makes "one live claim per key" a store guarantee, so a race has exactly one winner). Tokens are 256-bit values from `crypto.getRandomValues`; only a SHA-256 hash is stored, and no event, status, log line or idempotency record contains one. Item claims are mirrored into the seed `claims` table so the seed tick's dispatch and reaper keep working (the seed tests are unchanged).

## Requirements

| ID | Level | Status | Where |
|---|---|---|---|
| US-08-R01 one live claim per item | L1 | BUILT | `acquire`; unique index; tests T01, contention |
| US-08-R02 expiry and reaper returns item to ready | L1 | BUILT | `reapExpired`; T02, seed-reaper agreement |
| US-08-R03 untriggered item not dispatched | L1 | BUILT (claim side); dispatch itself is the seed tick | `acquire` refuses `trigger_not_done`; T04 |
| US-08-R04 no exit without disposition | L1 | BUILT (hook; the tick has its own) | `reopenSilentDrops`, `reconcile`; T03 |
| US-08-R05 gate card closes on probe | L1 | NOT COVERED here (BUILT in `worker/src/tick.js`) | |
| US-08-R06 heartbeat renewal | L1 | BUILT | `heartbeat` |
| US-08-R07 token, expiry, fence = previous + 1 | L2 | BUILT | `acquire`; T05 |
| US-08-R08 write only for live token and current fence | L2 | BUILT as `check` for the protected resource to call | `check`; T05 |
| US-08-R09 do not duplicate a live claim | L2 | BUILT | refusal with `same_intent` and shepherd advice |
| US-08-R10 record queue pulls | L2 | BUILT (`recordPull`; the caller must invoke it) | |
| US-08-R11 accounting invariant | L2 | BUILT per loop run; reopens unaccounted items, opens incident. Blocking parent closure is PLANNED | `recordLoopRun`; T06 |
| US-08-R12 rework escalation | L2 | BUILT (`recordRework`; caller reports each failed review) | |
| US-08-R13 orphan metric | L2 | BUILT | `metrics().orphaned_claims` |
| US-08-R14 interrupt-eligible step becomes one gate card | L2 | BUILT | `escalateToGate` |
| US-08-R15 idempotency keys on boundary side effects | L3 | PARTIAL: `idempotency_key` on acquire, release, loop runs; side effects outside this module are the caller's | |
| US-09 kill switch refuses claims, renewals, leases | cross-ref | BUILT (via `killSwitch()` port or `config.kill_switch`) | |
| US-14-R01 / R02 ports only | L1 | BUILT | no platform imports |
| US-14-R11 contention on a scale-out store | L3 | NOT COVERED: proven on one SQLite handle only; a multi-writer store needs the same unique-index semantics | |
| Visibility ratio across multiple issue stores (US-08 section 5) | L2 | PLANNED | |
| Principal-queue reroute of cards lacking an identity-bound line, beyond `escalateToGate` | L2 | PARTIAL | |

Secret lease: exclusive, TTL fixed by `lease_ttl_minutes`, keyed by secret name; any request carrying a value field is refused. Deploy lock: same primitives, TTL `deploy_ttl_minutes`.

Limit: claims are advisory except where the protected resource calls `check`. A stalled holder that never calls `check` is not stopped by the fence.
