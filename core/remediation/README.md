<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/remediation: failure modes beside the register

The register of failure modes, the remediation contract (owner, doer, trigger, closing probe, retry bound, deadline) and the loop breaker are in core/kernel (`../kernel/failure.js`). This module adds what the register does not hold and reads the kernel tables; it changes no kernel code. Written to US-SPEC-17. Nothing here is RUNNING.

```js
import * as remediation from './index.js';
const ctx = { db, now: () => Date.now(), config: { host: 'watcher', liveness: [{ table: 'probe_log', interval_min: 15, writer: 'prober' }] }, probeDb, rosters, ledgers };
await remediation.installStandard(ctx, { frozen: [{ table: 'probe_log', interval_min: 15 }] });
await remediation.step(ctx);
```

Migration: `migrations/0001_remediation.sql` (tables `remediation_*`; apply after the kernel and claims migrations). Tests: `remediation.test.js`.

## Requirements

| ID | Status | Where |
|---|---|---|
| US-17-R01 one hit row per run | BUILT in the kernel for registered detectors; BUILT here for the detectors this module hosts | `remediation_hits` |
| US-17-R02 clock in the same statement as the data | BUILT | `frozenSql` |
| US-17-R03 detector and severity; found twice without a detector is registered | BUILT | `installStandard`, `reportFailure` |
| US-17-R04 to R09 contract, consumer, closing probe, escalation, breaker, probation | BUILT in the kernel | `../kernel/failure.js`, `../kernel/failure.test.js` |
| US-17-R08 breaker for a ledger whose writer has none | BUILT | `breakerFromLedger`, `retryAllowed` |
| US-17-R10 one detector hosted outside the writer of its probe table | BUILT as a check that refuses to run in the writer and reads through a `probeDb` port. Deploying it as a second worker is the installer's step and is NOT COVERED | `externalLiveness` |
| US-17-R11 visibility ratio across issue stores | BUILT in core/claims, exported here | `../claims/gate.js` |
| US-17-R12 roster reconciliation with the emitter set | BUILT | `rosterReconcile`, `observedEmitters` |
| US-17-R13 a repository fix is not closed on repository evidence alone | BUILT | `closeFix` |
| Status view over the register | BUILT | `statusView`, route GET /failure-modes/status |
| Silent-drop reconciliation across loops | BUILT for the run ledgers of core/kernel, core/claims and core/fleet | `reconcileLoops` |
| entered = open + closed + superseded | BUILT: a vanished item is restored from an append-only ledger, an undisposed one reopened | `reconcileItems` |
| FM-COVERAGE, FM-SHADOW, FM-STALE-PREDICATE | NOT COVERED: they need a probe log, a deployer's candidate list and alarm definitions that no module here writes | |

Limit: detector statements that read time use the store's own clock, as the spec requires, so they are not driven by the injected `now`.
