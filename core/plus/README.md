<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/plus: the plus loop

Implements `US-SPEC-04`: a reserved share of capacity, a product registry, one plus at a time per product with a prediction and a separate guard, keep or revert on measured evidence, a simplify pass every fifth cycle, rest after three misses, a weekly digest. It uses the seed tables `items` and `gate_cards` only.

```js
import { registerProduct, capacity, plusStep } from './index.js';
await registerProduct(db, { product: 'desk', host: 'desk.example', program: 'REACH', usage_metric: 'requests_per_day', quality_measure: 'error_page_rate' });
const { plus_slots } = await capacity(db, { T: 25, now, config: config.plus });      // pass as config.kernel.plus_slots
await runTick(db, { config, extraSteps: [plusStep({ reader, propose })] });
```

Ports: `db`, `now`, `config.plus` (see `DEFAULTS`), `reader({ product, host, usage_metric }) -> { value, window_h, includes_machine }` (platform analytics), `propose({ product, kind, evidence }) -> fields of proposePlus` (the generator). Both are optional: with no reader, readings arrive through `recordReading`; with no proposer, writing the plus is filed as a work item for the product manager. Migration: `core/plus/migrations/0001_plus.sql`. The spec's `product_registry` is `plus_product_registry` here (module prefix).

## Requirement status

BUILT means implemented and covered by a passing test in `plus.test.js`. Nothing here is RUNNING.

| Requirement | Status | Where / note |
|---|---|---|
| US-04-R01 configurable reserved share (default 20%) | BUILT | `capacity`, `config.plus.plus_share` |
| US-04-R02, US-04-T01, US-04-T02 plus-share check and rebalance item | BUILT | the seed tick (`check_plus_share`); asserted here |
| US-04-R05 not reallocated to repair; lowered only by a row with an expiry | BUILT | `reduceShare`, `effectiveShare`; `core/kernel/programs.js` takes `config.kernel.plus_slots` off before it reads risk |
| US-04-R06 additive, reversible, single change (except simplify), prediction first | BUILT | `proposePlus` |
| US-04-R07 filed as an ordinary work item with a doer line | BUILT | `proposePlus` (item kind `plus`). Travelling the change path is the runner's part, not this module's |
| US-04-R08 guard separate from the outcome measure | BUILT | `registerProduct`, `proposePlus`, `decidePlus` |
| US-04-R09, US-04-T04 missing or stale reading is null, never 0, never a pass | BUILT | `recordReading`, `latestReading`, `decidePlus`. After a grace period (default 7 days) a still-unmeasured plus is reverted and counts as a miss |
| US-04-R10, US-04-T03 revert item, `misses_in_row`, different angle, `rest_until` after 3 | BUILT | `decidePlus`, `proposePlus` |
| US-04-R11 every Nth cycle is a simplify pass | BUILT | `cycleKind` |
| US-04-R12 a principal-only step is one gate card, never a question | BUILT | `principalStep` |
| US-04-R13 detector for unmeasured usage and a stale digest | BUILT | `detect` |
| US-04-R14 usage that counts machine requests is labelled | BUILT | `measureUsage` |
| Selection order, measurement cycle, daily cap, weekly digest | BUILT | `selectDue`, `runCycle`, `weeklyDigest` |
| Step 404 evidence | BUILT in part | `gatherEvidence` reads usage, guard, open fix items, the last kept plus and recent misses. Usage by section, slow routes, feedback and features of comparable products are NOT COVERED |
| US-04-R03, R04 every closed item and every review proposes a plus | NOT COVERED | SHOULD; belongs to the runner and reviewer prompts |
| A reader for a platform's analytics | NOT COVERED | needs a live account; the port is here, the adapter is not |
