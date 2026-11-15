<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/ghcost: code-host substrate cost control

Implements the parts of `US-SPEC-24` that are not a lint or a script: the Actions minutes watchdog as a tick step, the monthly ledger, the workflow kill switch with read-back, the spending-limit probe, the dead-man check, stagger, the census and the public-repository checklist. `tools/actions_budget.py` remains the command-line form of the same decision.

## Wiring

```js
import { ghcostSteps, deadman, handle } from './core/ghcost/index.js';
// config.ghcost = { enabled: true, org, budget: <content of ops/actions-budget.json>, repos?, every_ticks?, token_env? }
await runTick(db, { config, env, extraSteps: [...ghcostSteps({ fetch })] });   // watchdog, spending-limit probe, ledger publication
await deadman({ db, now, config });      // call from a trigger other than the tick (a request, a second alarm)
const res = await handle(request, { db });   // GET /ghcost/ledger?month=YYYY-MM, /ghcost/ledger.md
```

Ports: `ctx = { db, now, config, github }`. `github` is `githubPort({ fetch, env, org })` (`github.js`) or a fake. The token is read from `env` by name. Migration: `core/ghcost/migrations/0001_ghcost.sql` (after the seed migrations). Opt-in: nothing runs unless `config.ghcost.enabled`.

## Requirements

| ID | Status | Where |
|---|---|---|
| US-24-R04 deploy revertable to the previous Release | BUILT | `previousRelease`, `revertToPreviousRelease` (digest checked, goes through `core/deploy`) |
| US-24-R20 spending limit USD 0 with stop-usage, read back by a probe | BUILT (probe; the response fields follow the documented budgets endpoint, no recorded live response is held) | `evaluateSpendingLimit`, `spendingLimitProbe` |
| US-24-R21 one budget file, a ledger row per month and repository, published monthly | BUILT | `watchdog`, `ledger`, `publishDue`, `handle` |
| US-24-R22 Linux-equivalent minutes from the usage endpoint | BUILT against the documented field set and the figures observed on 2026-11-11; a recorded real response is NOT COVERED (this code has not read a live billing endpoint) | `minutesByRepo` |
| US-24-R23 card at 50 and 80 percent with the default in effect | BUILT | `watchdog` |
| US-24-R24 at 100 percent disable non-essential workflows, keep the test job, never raise a budget | BUILT | `enforce` |
| US-24-R25 kill switch row, drill that turns it off in every case | BUILT | `setKillSwitch`, `drill` |
| US-24-R26 exit status 0, 1, 2; runs from the tick | BUILT | `decide`, `ghcostSteps` |
| US-24-R43 public-repository checklist shown to the owner | BUILT | `publicChecklist` (gate card, default: stays private) |
| US-24-R50 deterministic stagger, measured collision count | BUILT | `staggerOffset`, `stagger`, `collisionCount` |
| US-24-R51 dead-man check independent of the scheduler | BUILT as a function; calling it from a second trigger is host wiring | `deadman` |
| US-24-R52 census before retiring; frozen or dead monitor files an item | BUILT | `census`, `censusRun`, `canRetire`, `monitorHealth`, `monitorRun` |
| US-24-R53 bounded retries | BUILT for this module's calls | `githubPort` |
| US-24-R54 outcome buckets sum to the scanned count | BUILT for the watchdog | `watchdog` |
| US-24-R55 a cost change overwritten from outside is detected from the deployed state | BUILT | `enforce` (drift item, state asserted again) |
| US-24-R03 Projects board, US-24-R05 Pages, US-24-R02 Discussions | NOT COVERED | |
| A job entry (`file.yml:job`) in the non-essential list | BUILT as a repository variable (`DISABLED_JOBS`); the workflow must honour it with an `if:` and that workflow edit is NOT COVERED here (protected path) | `githubPort.setWorkflow` |

Tests: `core/ghcost/ghcost.test.js`.
