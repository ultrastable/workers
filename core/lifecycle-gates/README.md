<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/lifecycle-gates: mode tailoring, iterations, status report, scope gate

Implements the requirements of `US-SPEC-15` that `core/kernel/lifecycle.js` leaves open. The kernel holds the five normative tables and the gates G1 to G3; this module adds the rules around them and calls the kernel's gate, never around it.

```js
import { startProject, submitTailored, advance, requestWork, lifecycleStep } from './index.js';
await startProject(db, { id: 'P', name: 'booking page', answers: {}, capacity: 3 }, { config: { portfolio_cap: 10 } });   // hybrid by default
await submitTailored(db, { project_id: 'P', kind: 'A-INI-2', path_or_ref: 'docs/P/charter.md', content: charter, produced_by: 'doer-1' });
await advance(db, 'P', 'planning', { readiness: (project) => elicit.readiness(project) });
await runTick(db, { config, extraSteps: [lifecycleStep()] });                                                             // status reports that are due
```

Ports: `db`, `now`, `config.lifecycle` (`portfolio_cap`, `initiation_threshold`, `require_readiness`, `status_period_h`, `scope_rules`), `readiness(project) -> number | { score }` (the readiness score of `US-SPEC-16`, served by `core/elicit`). Migration: `core/lifecycle-gates/migrations/0001_lifecycle_gates.sql` (apply after the seed and kernel migrations).

## Requirement status

BUILT means implemented and covered by a passing test in `lifecycle-gates.test.js`. Nothing here is RUNNING.

| Requirement | Status | Where / note |
|---|---|---|
| US-15-R02 selection rule; an override is a recorded decision | BUILT | `selectMode`, `startProject`, `lifecycle_mode_decisions` |
| US-15-R03, R13 the mode changes weight and form only; nothing is omitted | BUILT | `requiredArtifacts`, `checkForm`, `submitTailored`. Field lists exist for A-INI-1, A-INI-2, A-INI-6, A-PLN-4, A-PLN-5, A-PLN-6, A-PLN-9; any other artifact must have some content |
| G1: definition of done is a runnable probe; readiness score at least the threshold | BUILT | `advance`. The score is a port; a score that cannot be read does not pass |
| US-15-R08 every deliverable has a closing probe a different agent runs | BUILT | `recordDeliverable`, `runDeliverableProbe`; checked again at G3 |
| US-15-R09, T15-5 an iteration ends with a retrospective whose outputs are items | BUILT | `startIteration`, `endIteration`, `recordRetrospective` |
| US-15-R10 status report on the communication plan's period, predicted versus actual | BUILT | `produceStatusReport`, `refreshStatusReports`, `lifecycleStep` (A-MON-1 and A-MON-2) |
| US-15-R12, T15-4 an out-of-scope request is a scope-gate entry and no item until a recorded decision enables the pack | BUILT | `requestWork`, `decidePack`, `classifyScope`. The classifier is keyword rules restating the table in `SCOPE.md`; an upstream classifier can name the pack directly. Enabling a pack here records the decision; it does not install the pack in `core/packs` |
| US-15-R14 no start above the portfolio cap | BUILT | `startProject`, `lifecycle_capacity` |
| T15-1, T15-3, T15-6 through this layer | BUILT | asserted in `lifecycle-gates.test.js` |
| A-MON-4 risk review, A-MON-6 quality metrics | NOT COVERED | the `risks` table exists in the kernel; no step reviews it |
| G2 "every requirement maps to an item and a probe" | NOT COVERED | the kernel checks that items exist and have closing probes, not the mapping |
