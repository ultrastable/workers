<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/ignorance: what the system does not know is data

If a loop only improves what it knows, the circles of the known get smaller. This module makes the unknown a first-class input: a registry of gaps, miners that find them in any list of subjects, a red-team, inversion and pre-mortem pass, and a frontier of questions and leads that turns gaps into new work. Tenant-agnostic; Ultrastable runs it on itself and any tenant runs it on its own entries.

Method: Quni-Gudzinas, *Universal Ignorance Audit* (doi 10.5281/zenodo.21901984): five phases, fifteen questions (`UIA`), three regions (known unknowns, unknown unknowns, ignorance about ignorance). Combined with pre-mortems, inversion, assumption mapping, evidence-gap maps and adversarial collaboration (a challenger from a different model family than the author).

## Interface (ports: `store` {get,put}, `now`, optional `model`)

| Function | What it does |
|---|---|
| `createRegistry({store, now})` | gaps with `open` / `closed`; `upsert`, `close(id, {disposition, evidence})`, `list`, `summary`, `audit` (entered = open + closed) |
| `run({registry, subjects, graph?, rules?, miners?, model?, budget})` | one loop step: mine, challenge the stalest subjects, auto-close gaps whose condition is gone (with evidence), reopen regressions, return metrics and the frontier |
| `minersFor()` | assumptions, evidence, contradictions, estimates (interval, higher-order effects, counterfactual), unexplored areas; add your own `(ctx) => gaps` |
| `redTeam`, `ruleRedTeam`, `sanitizeModel` | deterministic floor (no model needed) plus an optional untrusted model; every finding names a falsifier and the audit question it answers |
| `frontier(gaps)` | questions, problem candidates, solution candidates (leads, never findings) |
| `administer`, `checkAnswers` | the full fifteen-question audit for one subject and its protocol rules (every question answered, "we do not know" allowed, Q15 seeds the next pass) |
| `publicView(registry, subject)` | what to show beside an entry: open gaps with how each would close, and recent closures |

Subjects are plain data: `{ id, type, title, claim, domain, evidence[], design, verdict, works_where, limits, who, assumptions[], problem_ids, effect{value,low,high,unit}, bca{higher_order[], counterfactual} }`. Map your entries into that shape.

## Configuration (org tick)

`config.ignorance = { enabled, budget, model_alias, author_family, token_env, models: { <alias>: { endpoint: 'github_models' | 'workers_ai', model, family } } }`. The token is read by name from the environment (`GITHUB_TOKEN` by default; in Actions, grant the job `models: read`); nothing is stored in config.

## Rules the code enforces

- A gap leaves the open set only by `close()` with a disposition (`resolved`, `accepted`, `superseded`) and evidence; nothing is dropped silently. `audit()` balances.
- Findings are challenges shown beside a subject; they never rewrite its claims. Model output is validated, capped and tagged `source: model`; it is refused from the author's own model family.
- The space must not shrink: four runs with nothing new set `stagnant` and widen the next pass.
- Coverage of the red team is itself a gap (`audit_coverage`): ignorance about ignorance is measured.

## Status

| Requirement | Status |
|---|---|
| IGN-1 registry with dispositions and balanced accounting | BUILT (`ignorance.test.js`) |
| IGN-2 miners for assumptions, evidence, contradictions, estimates, unexplored areas, graph gaps | BUILT |
| IGN-3 red-team, inversion, pre-mortem with deterministic floor and untrusted model | BUILT |
| IGN-4 frontier of questions and candidates; stagnation widens the pass | BUILT |
| IGN-5 fifteen-question administration and protocol check | BUILT |
| IGN-3b model-backed red team through GitHub Models (an Actions run's own token, `models: read`) or Workers AI, behind core/modelport; failure degrades to the rule floor | BUILT (`org.test.js`, `models.js`) |
| IGN-6 org-tick step `ignorance` (opt-in `config.ignorance.enabled`) over the org's open items: no closing probe, aged, blocked; records in `ignorance_state` | BUILT (`org.test.js`) |
| IGN-7 enabled in the Ultrastable tick Worker (`seed/worker`) | PLANNED (cross-repo, `Q-IGN-SELF`) |
