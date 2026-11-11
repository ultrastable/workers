<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/kernel: the L2 managerial layer

Extends the seed tick (`core/src/tick.js`) with metrics and triggers, a decision log, program charters with focus slots, risk snapshots, a failure-mode register with remediation contracts and a loop breaker, and the lifecycle records and gates of US-SPEC-15. It is generic: nothing here names an organization.

```js
import { runTick } from '../src/tick.js';
import { L2_EXTRA_STEPS, MIGRATIONS_DIR } from './index.js';
// apply core/migrations then MIGRATIONS_DIR, then:
await runTick(db, { config: { ...cfg, kernel: { slots: 25, manager_ops: true } }, extraSteps: L2_EXTRA_STEPS });
```

The only change outside this directory is the hook: `runTick` accepts `extraSteps: [{ name, run(db, ctx) }]` (default empty, so behavior and the L1 tests are unchanged). `runL2(db, ctx)` is that step; it runs nine guarded sub-steps (read metrics, risk snapshot, detectors, allocate, focus, decisions, remedies, remediate, lifecycle gaps), writes one evidence row each, and honors `config.kernel.manager_ops === false` (measurement continues, operations stop) and `config.kernel.enabled === false`.

Items belong to a program through `items.project` (the program id or the id of a `kernel_projects` row of that program). `kernel_item_meta` links an item to a metric and a doer.

Spec versions followed: US-SPEC-00, 03, 04, 05, 15, 17, all 0.1.0 draft. Level claim: partial L2 (see deviations below). Status labels follow US-00-R03: BUILT means the named test passes (`core/kernel/kernel.test.js`).

## Requirements

| ID | Requirement (short) | Status | Where / note |
|---|---|---|---|
| US-03-R11 | Evidence row per step; missing slot rows detected | BUILT | `kernel_step_evidence`, `checkPreviousSlot` (test: manager_ops / evidence) |
| US-03-R12 | Risk, verdict, quality index snapshotted once per tick | BUILT | `snapshotRisk`, `kernel_risk_snapshot` |
| US-03-R13 | Allocation never exceeds T | BUILT | `allocateSlots` (largest remainder) |
| US-03-R14 | Switches stop operations without deploy, measurement continues | BUILT | `config.kernel.manager_ops`, `enabled`; the schedule switch is the runtime's |
| US-03-R15 | Allocation writes a decision_log row with a parsable prediction | BUILT | `ALLOC-<tick>` decision |
| US-03-T06 | 120/40/20/15/5, T=25 gives 10/5/4/3/3 | BUILT | allocation test |
| US-03 s4 | Classification, escalation (x1.5, excess from lowest risk), ranking tiers, no-doer first | BUILT | `allocate`, `setFocus`; accelerate and maintain are labels only (maintain does not cap to one slot) |
| US-03 s4 | Queue score, operations (promote, supersede, assign doer), origination | NOT COVERED | |
| US-05-R01..R03, R04, R05 | L1 prediction scoring | BUILT in seed | not changed |
| US-05-R06 | Decision stored with prediction, authority and revert path before it executes | BUILT | `recordDecision` |
| US-05-R07 | Parsable prediction forms | BUILT | `parsePrediction` (metric, between, issue closed); kept in `kernel_decisions`, NOT copied into the seed `predictions` table because the seed scorer would score custom metrics as misses |
| US-05-R08 | Publish parsable share, miss rate, overdue unscored | BUILT (values) / PLANNED (triggers) | `decisionHealth` |
| US-05-R10, R11 | No close on code-only/staged; inferred needs label | NOT COVERED | |
| US-05-R09, R12, R13 | Probe-revert on deploy; independent verification; binned calibration | NOT COVERED | |
| US-05-R14 / US-17-R02 | Clock read with the data | BUILT | view uses `julianday('now')`; staleness check takes `now` with the data |
| US-04-R08, R09 | Guard measure separate from outcome; missing reading is null, not a pass | BUILT | metrics `kind=guard`, null readings, `unmeasured` state |
| US-05 keep/revert | Guard breached, unmeasured or worse blocks a target gain; revert item filed | BUILT | `evaluateDecision` |
| US-04-R10 | Revert item on a miss | BUILT | `REVERT-<id>`; `misses_in_row` and `rest_until` NOT COVERED |
| US-04-R05, R06, R07, R11, R12..R14 | Reserved share, product registry, simplify pass, digest | NOT COVERED | plus share check remains the seed's |
| Metrics | Registry with target, guard flag, read probe; trigger state by view, never stored; `metrics_in_breach` | BUILT | `kernel_metrics`, `kernel_v_metric_trigger_state`, `metricsInBreach` |
| US-17-R01 | One hit row per detector run, fired or not | BUILT | `runDetectors` |
| US-17-R03, R04 | Detector, severity and full contract required; firing opens an item with the contract | BUILT | `registerFailureMode`, `openRemediation` |
| US-17-R05 | One outcome bucket per scanned item; accounting invariant | BUILT | `consumeRemediations`, `recordLoopRun` (T04) |
| US-17-R06 | Close only when the closing probe passes | BUILT | `consumeRemediations` |
| US-17-R07 | After max attempts: gate card if interrupt-eligible, else reassign | BUILT | when all doers are exhausted the item is set `blocked` with the reason (a deviation: no human queue exists at this layer) |
| US-17-R08 | Loop breaker: suspend at k, root-cause item, half-open probe, interval grows | BUILT | `recordAttempt`, `canAttempt` (T03) |
| US-17-R09 | Detector with low confirmed share goes to probation | BUILT | `confirmFiring`, `reviewProbation` |
| FM-FROZEN | Detector that stopped writing hits is itself a failure | BUILT | `detectStaleDetectors` (T02) |
| US-17-T06 | Structured payload classification | BUILT | `payloadIsFailure` |
| Remedy rule | A remedy that did not move its metric in its window is replaced, not repeated | BUILT | `proposeRemedy`, `judgeRemedies` |
| US-17-R10..R12, R13 | Cross-worker detector, visibility ratio, roster emitter set, no close on repo evidence | NOT COVERED | L3 or integration |
| US-17 FM-COVERAGE, FM-MASKED, FM-UNBOUNDED-RETRY, ... | The named detectors | NOT COVERED | the register and detector engine are built; the named rows are configuration |
| US-15-R01 | Delivery mode and reason at initiation | BUILT | `createProject` |
| US-15-R03, R13 | Mode tailoring of artifact weight | NOT COVERED | all modes use the same required set |
| US-15-R04 | No phase entry before its gate; passes only on reviewed evidence | BUILT | `advancePhase`, `checkGate`; the Executing to Closing step has no named gate and is not gated |
| US-15-R05 | Artifact is a file or record, not chat | BUILT | `submitArtifact` rejects empty and chat refs |
| US-15-R06 | Change after a gate is a change request | BUILT | `amendArtifact`, `decideChangeRequest` (T15-3) |
| US-15-R07 | Reviewer differs from doer by agent and model family | BUILT | `reviewArtifact` (T15-2); family is the model name prefix before the first `-`, `:`, `/` or space |
| US-15-R08 | Every deliverable has a closing probe | BUILT (G2 items) | G2 requires every project item to have one |
| US-15-R11 | Item leaving the active set carries a disposition | BUILT | seed reconcile plus G3 (T15-6) |
| US-15 s8 | Tables phases, artifacts, change_requests, risks, lessons | BUILT | `0002_lifecycle.sql` |
| US-15 s7 | Tick files missing artifacts as items | BUILT | `lifecycleGaps`, T15-1 |
| US-15 A-CLO-3 | Each lesson files a plus item | BUILT | `addLesson` |
| US-15-R09, R10, R12, R14; T15-4, T15-5 | Retrospective, status report, scope gate, portfolio cap | NOT COVERED | |
| G1 | Definition-of-done probe, readiness score (US-SPEC-16) | NOT COVERED | |
| US-15 A-MON-4 | Periodic risk review | PLANNED | `addRisk` stores risks only |

## Deviations (US-00-R02)

Everything marked NOT COVERED above. Numeric defaults (T=25, k=3, 24 h windows, escalation 10% / 20% / 5 points, stalled = blocked items) are configuration-grade defaults per US-00-R07, set in `config.kernel` where practical.

## Tables

`kernel_*` for the layer's own records; `phases`, `artifacts`, `change_requests`, `risks`, `lessons` are normative names from US-SPEC-15 section 8. All migrations are idempotent.
