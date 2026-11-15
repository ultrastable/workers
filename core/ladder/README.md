<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/ladder: model ladder persistence

Implements the persisted parts of `US-SPEC-09` sections 4 and 5 that `core/router` does not hold: the capability matrix, the admission pipeline, capability-first candidates, the cascade with measured escalation, draft-then-verify (L6), shadow sampling, the demotion step and cost per verified outcome. `core/router` makes the provider calls; this module decides which admitted model may be asked and records what happened. Ports: `db`, `now`, and per call `canary`, `run`, `validate`, `draft`, `repair`. Migration: `migrations/0001_ladder.sql` (tables and view `ladder_*`; the specification's `model_task_matrix` and `model_admission` carry the prefix). Consumers: `step({ db, now, config })` is the tick surface (demotion); failed tasks and demotions become rows in `items`.

```js
import * as ladder from './index.js';
await ladder.setFloor(db, [{ pattern: '-(mini|nano)\\b', reason: 'small class' }]);
await ladder.admit(db, { model, task_class, rung: 1, unit_cost, need: { tool_calls: true }, decision: true, sample, canary });
await ladder.cascade(db, { task_id, task_class, need, run: (row) => router.call(...), validate, capBreached });
await ladder.draftThenVerify(db, { task_id, task_class, draft, repair, checks });
if (ladder.shouldShadow(decisionId)) await ladder.recordShadow(db, { model, task_class, decision_ref: decisionId, model_answer, label });
await ladder.step({ db, now });
```

## Requirement status

BUILT means implemented here and covered by a passing test in `ladder.test.js`. Nothing here is RUNNING; every model port is a fake in the tests.

| Requirement | Status | Where |
|---|---|---|
| Persisted capability matrix (section 4 table) | BUILT | `ladder_model_task_matrix`, written only by `admit` |
| Admission pipeline 2302 to 2316 (floor, canary, agreement by Wilson lower bound, gate, rung row) | BUILT | `admit`, `ladder_model_admission` |
| US-09-R07 cap steers to a free rung, never ends a task with a free path | BUILT | `cascade({ capBreached })`; the caller supplies the cap state (`core/router` computes it) |
| US-09-R08 capability first; price a tiebreaker | BUILT | `candidates`, `canRoute` |
| US-09-R09 escalation on a measured signal, one rung per failure, bounded, failed task filed | BUILT | `cascade`, `ladder_attempts` |
| US-09-R10 cost per verified outcome and escalation rate per class | BUILT | view `ladder_v_cost_per_task`. Cache hit rate and tool-call validity rate are NOT COVERED |
| US-09-R11 floor at admission and on a floor change | BUILT | `setFloor`, `floorViolation`, `monitor`. The guard that scans source and deployed bundles is NOT COVERED |
| US-09-R12 decision model gated by agreement lower bound | BUILT | `admit({ decision: true })` |
| Shadow sample of about 5% of decisions | BUILT | `shouldShadow`, `recordShadow`, `rollingAgreement` |
| Demotion step 2320, 2322 | BUILT | `monitor` |
| L6 draft then verify | BUILT | `draftThenVerify` |
| L0 handlers, L1 cache, L4 ensemble, L5 distilled specialist, L7 scheduler | NOT COVERED | L5 needs offline training on an organization's own task history |
| Standards gate (32,768 output, 128,000 context) and exemption registry | NOT COVERED | the matrix stores `ctx_tokens` and `max_out`; nothing checks them |
