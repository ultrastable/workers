<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/predict: predict, act, verify, score

Implements `US-SPEC-05` beyond the seed tick's four built-in metrics. Ports: `db` (D1-style), `now` (ms), `metrics` (`{ name: async (db, nowMs, row) => number }`), `read` (port to the running system for a deciding query), `config`. Migration: `migrations/0001_predict.sql` (tables and views `predict_*`; reads the seed `items`, writes one seed `outcomes` row per scored prediction that names a surface and action class). Consumers: `step({ db, now, metrics, read, config })` is the tick surface (scorer, re-test, calibration, health triggers); health breaches and re-tests become rows in `items`.

```js
import * as predict from './index.js';
await predict.recordDecision(db, { id, decision, predicted_outcome: 'queue_depth <= 5 within 24 h', revert_path, confidence: 0.85, decision_type: 'merge' }, { now });
await predict.step({ db, now, metrics });                      // score what is due, re-test, calibrate, check health
await predict.gateConfidence(db, { decision_type: 'merge', confidence: 0.85, threshold: 0.8 });
await predict.recordAssertion(db, { finding_id, state: 'staged', deciding_query, pass_condition: '> 0', fail_condition, null_expectation });
await predict.observe(db, finding_id, { read, verified_by });  // the only way to reach `observed`
await predict.closeFinding(db, finding_id);
```

## Requirement status

BUILT means implemented here and covered by a passing test in `predict.test.js`. Nothing here is RUNNING.

| Requirement | Status | Where |
|---|---|---|
| US-05-R01 prediction names metric, operator, target, due time | BUILT | `insertPrediction` refuses anything else |
| US-05-R02 scorer evaluates every due prediction, stores observed and verdict, writes an outcome row | BUILT | `scoreDue`, `predict_outcomes` |
| US-05-R03 unknown metric or operator scores as a miss | BUILT | `scoreDue` (also a metric that throws or returns no number) |
| US-05-R04, R05 no close on a merge alone; a done check never observed leaves the item open | BUILT for findings closed through `closeFinding` | items closed by other code paths are outside this module |
| US-05-R06 decision stored with predicted outcome and revert path before it executes | BUILT | `recordDecision` (`execute` runs after both rows exist) |
| US-05-R07 parsable forms copied to the prediction table | BUILT | `parsePrediction`, `findPrediction`; the copy is done by `recordDecision`, not a database trigger |
| US-05-R08 parsable share, miss rate, unscored overdue, each with a trigger | BUILT | `health`, `checkHealth` (one item per number and day) |
| US-05-R09 pre-passing probe that fails reverts the deploy | BUILT in `core/deploy` | see its README |
| US-05-R10, R11 assertion states enforced by program | BUILT | `recordAssertion`, `observe`, `closeFinding`, `retestDue` |
| US-05-R12 independent verification path | BUILT | `observe({ verified_by, require_independent })`; recorded per assertion |
| US-05-R13 binned calibration per decision type, confidence corrected | BUILT | `binnedCalibration`, `calibrate`, `gateConfidence`, view `predict_v_calibration_bins` |
| US-05-R14 clock read in the same statement as the data | NOT COVERED here | `core/kernel` view `kernel_v_metric_trigger_state`; this module takes `now` as a port so tests are deterministic |
| Section 3.2 calibration views by persona, action class, surface | BUILT | `predict_v_calibration_*`, `calibrationViews` |
| Outside audit of the scorer | NOT COVERED | PLANNED in the specification |
