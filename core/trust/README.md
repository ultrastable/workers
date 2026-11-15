<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/trust: trust ledger, ladder and interrupt gate

Implements the parts of `US-SPEC-06` the seed tick does not: event weights, decay toward the prior, a windowed severe count, per-executor trust, recorded transitions applied only by a different agent's merge, the gate card queue, reversibility engineering, standing limits above any rung, and the policy validator in JavaScript. The seed tick (`core/src/tick.js`) keeps computing `trust_ledger`; this module reads it and writes its rung only in `applyRungChange`. Ports: `db`, `now`, `policy` (the content of `autonomy/policy.json`), `config`. Migration: `migrations/0001_trust.sql` (tables `trust_*`). Consumers: `step({ db, policy, config, now })` is the tick surface; proposals are `items` of kind `ladder`, rerouted cards are `items`.

```js
import * as trust from './index.js';
trust.assertPolicy(policy);                                         // boot: an invalid policy throws
await trust.step({ db, policy, now });                              // scores, proposals, reroutes
await trust.authorize(db, { surface, action_class, target, executor, required_rung, limits, reversible_forms, card }, { policy, now });
await trust.applyRungChange(db, { item_id, merged_by, policy, now }); // the merge of a reviewed change
await trust.recordEvent(db, { surface, action_class, executor, event: 'hidden_failure' }, { now });
```

Config (`config`): `severe_window_days` (default: the policy's `no_hidden_failure_days`, 14; `null` = all time), `decay_per_unit` (default: the policy's `decay_per_idle_day`), `decay_unit` (`day` or `tick`), `event_weights`, `mode` (`threshold` or `banded`), `bands`, `opened_by`.

## Requirement status

BUILT means implemented here and covered by a passing test in `trust.test.js`. Nothing here is RUNNING.

| Requirement | Status | Where |
|---|---|---|
| US-06-R01 ledger keyed by pair, recomputed from outcomes | BUILT | `recompute` (`trust_scores`); the seed tick keeps `trust_ledger` |
| US-06-R02 no outcomes gives the baseline | BUILT | `reliability` |
| US-06-R03 formula and prior stated in the policy | BUILT | `settings` refuses a policy that does not state them |
| US-06-R04 rung never above the surface ceiling | BUILT | `recompute`, `applyRungChange`, `effectiveRung` |
| US-06-R05 the tick changes no rung; a crossing opens a ladder item | BUILT | `recompute` (item id carries the date on a repeat crossing) |
| US-06-R06 rung change merged by a different agent | BUILT | `applyRungChange` |
| US-06-R07 severe outcomes demote; window stated | BUILT | `severe_window_days` |
| US-06-R08 irreversible and identity-bound: gate card at any rung | BUILT | `authorize` |
| US-06-R09 card needs closing probe and default; manual never closed by the tick | BUILT | `openCard`; closing is the seed step `probe_gates` |
| US-06-R10 only presence of a secret recorded | NOT COVERED here | bootstrapper and `core/deploy` |
| US-06-R11, R12 policy validator; money, legal, outreach, secrets below execute | BUILT | `validatePolicy`, `assertPolicy`; the Python validator stays in `bootstrap/bootstrap.py` |
| US-06-R13 standing limits outrank rung and score | BUILT | `authorize`, `recordRefusal`, `maySubmit` |
| US-06-R14 reversibility engineering before classifying irreversible | BUILT | `authorize({ reversible_forms })`, `trust_reversibility_attempts` |
| US-06-R15 step without an identity-bound line rerouted; metric | BUILT | `openCard`, `rerouteUnbound`, `cardsWithoutIdentityLine` |
| US-06-R16 reversible in-scope question answered by the default | BUILT | `adoptDefault` (`trust_adoptions`) |
| US-06-R17 transitions recorded with evidence | BUILT | `trust_transitions` |
| US-06-R18 queue multiplier | BUILT | `queueMultiplier`; no queue uses it yet |
| US-06-R19 per-executor trust, minimum of executor and pair | BUILT | `effectiveRung`, `trust_executor_rungs` |
| Event weights, decay toward the prior, lower confidence bound, banded ladder (section 3 alternatives) | BUILT | `recordEvent`, `decayToward`, `wilsonLower` (stored, not used for rungs), `rungForScore` |
| Mirror rule | BUILT as a function | `mirrorProblems(policy, harnessDeny)`; the caller supplies the harness deny list |
| US-06-T05, T06 boot without a credential; planted secret | NOT COVERED here | bootstrapper tests |
