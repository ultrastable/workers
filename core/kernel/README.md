<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/kernel: the L2 managerial layer

A small, generic implementation of the L2 requirements of `US-SPEC-03` s4, `04`, `05`, `15` and `17`. It extends the seed tick (`core/src/tick.js`) and never changes its behavior: the seven L1 steps and their tests are untouched.

```js
import { runTick } from '../src/tick.js';
import { L2_EXTRA_STEPS, MIGRATIONS_DIR } from './index.js';
await runTick(db, { config, extraSteps: L2_EXTRA_STEPS });   // L1 steps, then one 'l2' step
```

`extraSteps` is the one backward-compatible hook added to `core/src/tick.js` (`[{ name, run(db, ctx) }]`, guarded like any step; omitted means the seven L1 steps). `runL2(db, ctx)` runs nine guarded sub-steps in order: `read_metrics`, `risk_snapshot`, `detectors`, `allocate`, `focus`, `decisions`, `remedies`, `remediate`, `lifecycle`. Each writes a `kernel_step_evidence` row.

Configuration (`config.kernel`): `enabled` (false: L2 does nothing), `manager_ops` (false: measurement and detectors keep running, allocation, focus, decisions, remedies, remediation and gate filing stop), `slots` (T, default 25), `plus_slots` (slots reserved for the plus loop, taken off T before allocation; default 0), `high_priority_max` (default 10), `guard_tolerance`. Conventions: a program's items carry `items.project = <program id>` or the id of a kernel project in that program. Migrations: `core/kernel/migrations/0001_kernel.sql`, `core/kernel/migrations/0002_lifecycle.sql` (apply after the seed migrations; idempotent).

## Requirement status

BUILT means implemented and covered by a passing test in this directory. Nothing here is RUNNING (no production use).

| Requirement | Status | Where / note |
|---|---|---|
| US-03-R11 evidence row per step; missing rows detected | BUILT | `kernel_step_evidence`, `L2MISSING-<tick>` (`l2.test.js`) |
| US-03-R12 risk, verdict, quality index snapshot once per tick | BUILT | `snapshotRisk` (`programs.test.js`). "Stalled projects" S is counted as blocked items |
| US-03-R13 allocation never above T | BUILT | `allocateSlots`, largest-remainder rounding |
| US-03-R14 switches stop operations, measurement continues | BUILT | `config.kernel.manager_ops`, `enabled`. The schedule switch that stops the tick entirely belongs to the runtime, not this layer |
| US-03-R15 allocation writes a decision with a parsable prediction | BUILT | `ALLOC-<tick>` rows |
| US-03-T06 allocation 120/40/20/15/5, T=25 gives 10/5/4/3/3 | BUILT | `programs.test.js` |
| US-03 s4 classification (constrain, escalate, accelerate, maintain, steady, idle) | BUILT | "maintain: one slot" is not enforced as a cap; the worked example gives GREEN programs more |
| US-03 s4 ranking and focus; no-doer items first | BUILT | tiers 0 to 4, then no doer, priority, age. The queue score formula is in `core/staff/score.js` |
| US-03 s4 operations (promote, restore, close with evidence, supersede, demote, assign doer with anchor validation), daily origination | not this layer | BUILT in `core/staff` (`core/staff/staff.test.js`); the research agent is a port there. Rerouting parked tasks is NOT COVERED |
| US-03-R16 duplicate scheduler firing | NOT COVERED | L3 |
| US-05-R01..R03, R05 prediction scoring in the seed | not this layer | seed (`score_predictions`) |
| US-05-R06 decision stored with prediction, authority, revert path | BUILT | `kernel_decisions`, `recordDecision` |
| US-05-R07 parsable prediction forms | BUILT | `parsePrediction` (metric, `between`, `issue closed`). Own table: the seed's scorer would score a custom metric as a miss, so decisions are not copied into `predictions` |
| US-05-R08 parsable share, miss rate, unscored overdue | BUILT | `decisionHealth`. The trigger on each is not registered (no metric registry rows are seeded) |
| US-05-R14, US-17-R02 clock read in the same statement as the data | BUILT | view `kernel_v_metric_trigger_state`; `detectStaleDetectors` |
| US-05-R09, R12, R13, R10/R11 (probes revert deploys, calibration bins, assertion states) | NOT COVERED | deploy path is outside this layer |
| Metric registry: target, guard flag, read probe, trigger by view | BUILT | `kernel_metrics`, `kernel_v_metric_trigger_state` (`hit = 1` is a breach; unmeasured is never a pass) |
| Guard blocks a target gain from being kept | BUILT | `evaluateDecision` (guard breached, unmeasured or worse than at decision time) |
| US-04-R09 missing or stale reading is null, never 0 | BUILT | `readMetric`, view |
| US-04-R10 miss: revert item filed | BUILT | `REVERT-<id>` for decisions. `misses_in_row` and `rest_until` belong to the product registry in `core/plus` |
| US-04-R01, R05..R08, R11..R14 plus loop, product registry, simplify pass, digest | not this layer | BUILT in `core/plus` (`core/plus/plus.test.js`). Here: `config.kernel.plus_slots` is taken off T before risk is read (R05). R02 plus-share rebalance is in the seed |
| US-17-R01 one hit row per detector run | BUILT | `runDetectors` (errors are rows too) |
| US-17-R03, R04 detector, severity and full contract required | BUILT | `registerFailureMode` |
| US-17-R05 one outcome bucket per scanned item; accounting invariant | BUILT | `consumeRemediations`, `recordLoopRun` (incident plus reopen) |
| US-17-R06 close only when the closing probe passes | BUILT | |
| US-17-R07 after max attempts: gate card if interrupt-eligible, else reassign | BUILT | when doers run out the item is blocked with the reason |
| US-17-R08 loop breaker with root-cause item and half-open probe | BUILT | `recordAttempt`, `canAttempt` (k, window, interval configurable) |
| US-17-R09 probation for a detector whose firings are mostly refuted | BUILT | `confirmFiring`, `reviewProbation` |
| US-17-T06 structured payload classification | BUILT | `payloadIsFailure` |
| Remedy not moving its metric in its window is replaced, not repeated | BUILT | `proposeRemedy`, `judgeRemedies` (refuses a repeat of a replaced remedy; one active remedy per metric) |
| US-17-R10..R12, R13 external host, visibility ratio, roster, repository-only closure | NOT COVERED | L3 / deploy path |
| US-15-R01 delivery mode with reason | BUILT | `createProject` |
| US-15-R04 gates G1, G2, G3 and the gate check function | BUILT | `checkGate`, `advancePhase`. Executing to closing has no named gate in the spec and is not gated |
| US-15-R05 artifact is a file or record, not chat | BUILT | `submitArtifact` |
| US-15-R06 change after a gate is a change request with revert path | BUILT | `amendArtifact`, `decideChangeRequest` |
| US-15-R07 reviewer differs from doer (agent, and model family when both known) | BUILT | `reviewArtifact`, re-checked by `checkGate` |
| US-15-R11 disposition on leaving the active set | BUILT | seed reconcile; G3 checks it per project |
| US-15 s8 tables `phases`, `artifacts`, `change_requests`, `risks`, `lessons` | BUILT | `core/kernel/migrations/0002_lifecycle.sql` |
| US-15 A-CLO-3 lesson filed into the plus queue | BUILT | `addLesson` |
| US-15 s7 tick files missing gate artifacts | BUILT | `lifecycleGaps` |
| US-15-T1, T2, T3, T6 | BUILT | `lifecycle.test.js` |
| US-15-R02, R03, R08..R10, R12..R14, T4, T5 (mode selection rule, iterations, scope gate, status report, portfolio cap), G1 readiness score and charter probe | not this layer | BUILT in `core/lifecycle-gates` (`core/lifecycle-gates/lifecycle-gates.test.js`), which calls `advancePhase` after its own checks |

## Deviation list (US-00-R02)

Level claim: partial L2. Not met: the NOT COVERED rows above. The status report (A-MON-1) and variance (A-MON-2) are produced by `core/lifecycle-gates`; the risk review (A-MON-4) is a table only, no step produces it yet.
