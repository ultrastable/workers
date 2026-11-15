<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/sla: service levels, audits, step budgets, objective, autonomy card

US-SPEC-13 sections 4 and 5. One `step(ctx, { l3 })` per tick runs all of it; `l3` is `createConsoleL3` from `core/console-l3`.

| Requirement | Status |
|---|---|
| US-13-R07 severity and due date per open row, recomputed each tick | BUILT (`recompute`, `sla.test.js`) |
| US-13-R08 14-day hard cap, three exemptions, acceleration rule (US-13-T03) | BUILT |
| US-13-R09 past due: one priority level up and the manager notified, once per missed date | BUILT (`sla_notices`) |
| US-13-R10 items waiting on a person as a metric with target zero | BUILT (`waitingOnPerson`, `sla_metrics`, one item with a closing probe) |
| Weekly audit (due date or executor per open row) | BUILT (`weeklyAudit`, `sla_audits`) |
| US-13-R11 per-step budgets from stored step runs, breach procedure (US-13-T04) | BUILT (`startStep`, `stepRuns`, handed to `sweepStepBudgets`) |
| US-13-R12 one done check per process, at least two paths per step | BUILT (`defineProcess`, `processGaps`) |
| Six-term F and the triad, stored with weights | BUILT (`objective`); `drift_count`, `cost_overrun` and `integration_gap` are read only when the caller passes them, and the weights are uncalibrated defaults |
| Monthly autonomy card from tables, three largest gaps filed (US-13-T05) | BUILT (`recomputeAutonomyCard`); the ten dimensions are this module's own, read from L1 tables, not the ten of the source design |
| Outside audit of the card | NOT COVERED |

Ports: `db`, `now`, `config`. Owner role: portfolio-manager. Trigger: every tick. Closing probe: `node --test core/sla/sla.test.js`.
