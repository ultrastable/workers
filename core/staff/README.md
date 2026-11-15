<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/staff: virtual staff, their authority and their lane

Implements the L2 requirements of `US-SPEC-02` (R05 to R11) and the manager operations, queue score and origination of `US-SPEC-03` s4. It sits on `core/kernel` (it reads `kernel_focus`, `kernel_item_meta`, `kernel_metrics`, `kernel_allocations`) and never changes it.

```js
import { runTick } from '../src/tick.js';
import { L2_EXTRA_STEPS } from '../kernel/index.js';
import { registerPersona, createToolLayer, staffStep } from './index.js';
await registerPersona(db, { id: 'pgm-ops', role: 'program-manager', program_id: 'OPS', scope: 'program OPS', instruction_source: 'agents/roles/product-manager.md',
  authority: ['promote', 'restore', 'close_with_evidence', 'supersede', 'assign_doer', 'originate', 'score'] });
await runTick(db, { config, extraSteps: [...L2_EXTRA_STEPS, staffStep({ readFile, research })] });   // after the kernel's 'l2' step
const tools = createToolLayer({ db, now, config: config.staff, ports: { readFile, research } });
await tools.act('pgm-ops', 'promote', { item_id: 'A', prediction: 'm >= 1 within 24 h' });            // a person filling the role calls the same thing
```

Ports: `db`, `now`, `config.staff` (see `DEFAULTS` in `index.js`), `readFile(path)` (anchor validation), `research(request)` (origination; returns text with the fields TITLE, WHY, code-task, code-anchor, EDIT). Migration: `core/staff/migrations/0001_staff.sql` (apply after the seed and kernel migrations).

## Requirement status

BUILT means implemented and covered by a passing test in `staff.test.js`. Nothing here is RUNNING.

| Requirement | Status | Where / note |
|---|---|---|
| US-02-R05 enumerated decision authority; only listed operations are applied | BUILT | `registerPersona` (list required, role ceiling), `act` (refusal recorded in `staff_denials`, nothing changed) |
| US-02-R06 operation recorded with id, item, from, to, evidence; reversible by recording the reverse | BUILT | `staff_actions`, `reverse` |
| US-02-R07 one brief per persona per tick it runs | BUILT | `writeBrief`, `runManagers`, `missingBriefs` |
| US-02-R08 program manager within its own program; portfolio manager demotes machine-filed items across programs | BUILT | `ROLE_CEILING`, lane check in `act` |
| US-02-R09, US-02-T03 no origination in, and no read of, another plane; enforced by the tool layer from the requester's identity | BUILT | `items`, `readStore`, `originate`. The layer guards the tools it offers; a caller holding the raw `db` handle is outside it, so the composition root must hand agents the tool layer and not the handle |
| US-02-R10 managers never target control-plane files | BUILT | `isControlPlane` in `assign_doer` and `originate`. The list is `config.staff.control_plane` |
| US-02-R11 a role filled by a person: same records, predictions, briefs, trust outcome | BUILT | `filled_by: 'person'`; the tick never acts for a person |
| US-02-T01, US-02-T02 dispatch by `owner_role`; a new role row needs no code change | BUILT | the seed tick; asserted in `staff.test.js` |
| US-01-R07 score rows carry their writer; a persona deletes only its own | BUILT | `staff_priority_scores`, `deleteScore` |
| US-03 s4 queue score, both worked examples | BUILT | `queueScore`, `scoreItem`, `rankQueue`. Focus items take the full factors; any other item needs an assessment. `direction` is an input (default 0): inferring it is L3 |
| US-03 s4 operations: promote, restore, close with evidence, supersede, demote, assign a doer (anchor exactly once) | BUILT | `HANDLERS` in `index.js` |
| US-03 s4 origination: once a day, fewer than 3 open roadmap items, five fields, daily cap 4 | BUILT | `originate`, `parseProposal`. The research agent is a port; no model call is made here |
| US-03 s4 reroute parked tasks | NOT COVERED | |
| US-02-R05 for the kernel's own allocation | NOT COVERED | the kernel allocates by rule; this module logs that allocation as the portfolio persona's operation when `allocate` is on its list, and says so in the brief when it is not, but does not stop it |
| US-02-T04 reviewer on a different model family | not this module | `core/kernel/lifecycle.js` (`reviewArtifact`) and the bootstrapper |
