<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/describe: self-description and the claims registry

The organization describes itself from its own records, and every factual sentence is a claim with a probe that can be re-run (`US-SPEC-22`, with `US-SPEC-21` s7 where describe is a core feature, not a pack). Output is in three forms from one self-model; a voice checker, run separately from the writer, gates every text form. The loop writes only to the database (class A); publishing is a pack's job.

## Wiring

```js
import { addClaims, describeExtraSteps, handle } from './core/describe/index.js';
import { loadSeedClaims, loadVoiceRules } from './core/describe/load.js'; // Node-only; a Worker passes the JSON in
await addClaims(db, loadSeedClaims());                       // once; INSERT OR IGNORE
const opts = { fetch, readFile, getSpecStatus, packs, scope, voiceRules, compose /* optional */ };
await runTick(db, { config, extraSteps: [...describeExtraSteps(opts)] });
// GET /describe, /describe.json, /llms.txt
const response = await handle(request, { db, now: Date.now(), ...opts, specStatus });
```

Migration: `core/describe/migrations/0001_describe.sql` (tables `describe_claims`, `describe_outputs`).

| Port or input | Meaning |
|---|---|
| `readFile(path)` | injected reader for `file:` probes; a throw means the file is missing (fail) |
| `fetch` | injected, used only for `http:` probes (GET) |
| `specStatus` | snapshot `{ BUILT, RUNNING_ONLY, PLANNED, 'NOT COVERED', total, planned_names, by_spec? }`, the counts of `tools/spec_backlog.py` |
| `packs`, `scope` | enabled packs and `{ purpose?, in_scope?, out_of_scope? }`; `parseScopeMd` reads the out-of-scope table of `SCOPE.md` |
| `compose({ form, section, claims })` | optional phrasing port (a model may be behind it); default is a deterministic template. It cannot add a claim: the checker rejects it |
| `voiceRules` | data: `banned`, `out_of_scope` (pack and terms), `negation`, `version` (see `voice-rules.json`) |

Claims use probe kinds `sql:<one SELECT>` (the token `{now}` is the injected time; a `names` column feeds `{names}`), `file:<path>`, `http:<url>`, `spec:<STATUS>` or `spec:<specId>.<STATUS>`. `expect` is `>=N`, `<=N`, `>N`, `<N`, `=N`, `!=N`, `exists`, `nonempty`, `contains:X` or `status:N`. Claim text is a template with `{value}`, `{names}`, `{date}`; a number without `{date}` gets "(as of DATE)" appended. A claim id prefix (`purpose.`, `capabilities.`, `scope.`, `operation.`, `performance.`, `packs.`, `limits.`) places it in a section of the self-model. Sentences carry a marker `[claim:<id>]`.

## Requirement status

| Requirement | Status | Where |
|---|---|---|
| US-22-R01 every factual statement is a claim with a probe; read-only probes | BUILT (sql accepts one SELECT only) | `assertReadOnlySql`, `runProbes`, `checkVoice` |
| US-22-R02 failing, unknown or stale public claim withdrawn, repair item filed | BUILT | `runProbes`, `withdrawStale`, `isPublishable`, `handle` re-render |
| US-22-R03 limits and PLANNED alongside capabilities | BUILT (own section, same heading level, named in the short statement) | `buildSelfModel`, `render` |
| US-22-R04 three forms from one model (statement, page, JSON plus llms.txt) | BUILT | `render` |
| US-22-R05 packs take facts from the registry; free text cannot add a claim | BUILT for this module's outputs (`compose` port + checker). A pack's own use of the registry is that pack's | `compose`, `checkVoice` |
| US-22-R06 numbers carry a date; estimates labeled | BUILT | `renderClaimText`, `checkVoice` |
| US-22-R07 voice rules are data, versioned, applied by a separate checker | BUILT (data file with `version`; checker is an injected pure function). Which agent runs it is wiring | `voice-rules.json`, `checkVoice`, `describeOnce({ checker })` |
| US-22-R08 no out-of-scope output as done unless the pack is enabled | BUILT (term lists in the rules data) | `checkVoice` |
| US-22-R09 writes only to the db, never publishes | BUILT | `describeExtraSteps`; `handle` serves, writes nothing |
| T22-1 to T22-5 | BUILT | `describe.test.js` |
| Self-model s3: Purpose, Capabilities, Scope, Operation, Performance, Packs, Limits | BUILT from claims plus record facts; the JSON form publishes claims only, record facts stay in the model | `buildSelfModel` |
| Live product page with a hourly contract and a claims feed API | NOT COVERED (adapter and cron wiring) | |
| Cost per merged change, pull requests merged and rejected | PLANNED (needs a claim with a probe over the runner's tables) | |
