<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/governance: self-amending governance

Implements section 3 of `US-SPEC-07`: the signature register as rows, the recognition engine, the pre-emission filter, the self-amendment loop with a protected-set check, red-team and replay, and the objective space. The canonical change path (section 4) is `core/deploy`. Ports: `db`, `now`, and model ports passed per call: `execute`, `dispatch`, `deduct`, `classifier`, `revise`, `generate`, `redteam { family, attack }`, `evaluate`. No model is called by this module itself. Migration: `migrations/0001_governance.sql` (tables `governance_*`; the specification's `false_stop_*` tables carry the prefix). Consumers: `step({ db, now, generate, redteam, evaluate })` is the tick surface; unresolved steps, audits and adopted goals become rows in `items`; adoption writes `governance_lineage` and the seed `doctrine_lineage`.

```js
import * as gov from './index.js';
import * as trust from '../trust/index.js';
await gov.seedRegister(db);
const out = await gov.preEmit(db, { draft, source: agentId, ctx: { surface, action_class, agent: agentId, action, surfaces } },
  { revise, execute, dispatch, deduct: (d) => trust.recordEvent(db, d) });
emit(out.emitted);
await gov.step({ db, now, generate, redteam });                 // proposals up to, not including, adoption
await gov.adopt(db, proposalId, { reviewer });                  // the reviewed change
gov.loadLoopPrompt({ name, prompt });                           // throws when the commitments are missing
```

## Requirement status

BUILT means implemented here and covered by a passing test in `governance.test.js`. Nothing here is RUNNING. The model ports are exercised with fakes; no live model has run this loop.

| Requirement | Status | Where |
|---|---|---|
| US-07-R01 amendment increments a version recorded in lineage | BUILT for register amendments | `adopt` (reviewer must differ from author). Amendments to the policy file or role files travel the repository's review path, not this function |
| US-07-R02 red-team by a second model and replay before adoption | BUILT | `redTeam` (different family required), `replay` (stored scans of 7 days, ticks counted) |
| US-07-R03, R04 amendment touching a protected limit or commitment rejected without replay | BUILT | `protectedProblems` (structured targets and rule text), run by code before any model |
| US-07-R05 exclusions: refusal with reason, interrupt-eligible, other agent's live claim | BUILT | `recognize` (the refusal and the gate state come in `ctx`; the claim is read from `claims`) |
| US-07-R06 rewritten output true when emitted | BUILT | `recognize`: a statement is emitted only from a verified result with something to read back; otherwise dispatch or open item |
| US-07-R07 every hit recorded | BUILT | `governance_false_stop_hits`, `governance_scans` |
| US-07-R08 a refusal is an input, no resubmission in other words | BUILT in `core/trust` | `recordRefusal`, `maySubmit` |
| US-07-R09 control-plane files only by reviewed change | NOT COVERED | repository policy and CI |
| US-07-R10 to R13 change path | BUILT in `core/deploy` | see its README |
| US-07-R14 no agent writes a ratified objective; revision never adopted by its author | BUILT | `ratifyObjective`, `setObjectiveStatus` |
| US-07-R15 adopted goal has parent and alignment; novel goal on probation, not dispatched | BUILT | `adoptGoals`, `drainGoalLedger`, `retireGoals` |
| US-07-R16 prompt without the commitments rejected | BUILT | `loadLoopPrompt`, `missingCommitments` |
| US-07-R17 pre-emission filter, masking, at most R revisions | BUILT | `preEmit`, `mask` |
| Classifier-port matching | BUILT as a port | `recognize({ classifier })`; no classifier model ships |
| Threshold proposals (3 in 7 days from one source, friction once), weekly audit item | BUILT | `scanThresholds`, `auditItem` |
| Event-weighted trust deductions per recognition | BUILT | `governance_deductions` and the `deduct` port (wired to `core/trust` in the test) |
| Section 3.1 rates (false-stop, conditional-offer, question, actor-assignment, narration) | BUILT as a read | `rates`; triggers on them are not registered; self-adoption rate is NOT COVERED |
| Daily goal cycle: signal gathering and candidate synthesis | NOT COVERED | needs a model; `adoptGoals` takes candidates as input |
| Gathering principal messages and agent outputs to scan | NOT COVERED | the caller passes each draft to `preEmit` or `recognize` |
