<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/: the reproducible parts

Each directory here is one module of the Ultrastable core, written to the specifications in `ultrastable/spec` and independent of any particular organization. A module is done when a stranger can install it with nothing but this repository.

## Rules for every module

1. **Spec first.** The module implements named requirements from `ultrastable/spec` (`US-SPEC-NN`) and cites them in its README and tests.
2. **Ports, not globals.** A module takes its dependencies as arguments: `db` (D1-style handle: `prepare().bind().all()/first()/run()`), `fetch`, `now`, `config`, `env` (presence of secrets only). Nothing reads ambient state.
3. **Configuration, not constants.** Account ids, hostnames, repository names, owner contact, model names and budgets come from `config`. No default value may name a real tenant.
4. **No tenant names.** `core/test/no-qnfo.test.js` fails the build if code or configuration contains QNFO identifiers, hosts or account ids.
5. **Own migrations.** `core/<module>/migrations/NNNN_name.sql`, tables prefixed with the module name. Never edit another module's migration. Idempotent (`IF NOT EXISTS`).
6. **Tests.** `node:test`, using `core/_shared/testdb.js` (`makeDb([migrationDirs])`). Cover every requirement marked MUST and the conformance tests of the spec.
7. **Honest status.** The module README says BUILT, PLANNED or NOT COVERED for each requirement.
8. **Platform-agnostic.** Standard web APIs and Node built-ins only. No Cloudflare-only or Google-only imports in module logic; those go in `adapters/`.

## Modules

| Module | Spec | Status |
|---|---|---|
| `benefitcost` | WELLBY benefit-cost with causal chains, evidence grades, Monte Carlo and an evidence-pooling loop | BUILT (see its README) |
| `claims`, `deploy`, `kernel`, `router` | US-SPEC-08, 07, 03-05, 09 | BUILT |
| `yield` | cost per output, waste findings | BUILT |
| `docgate` | documents traced to work | BUILT |
| `intent` | request intake | BUILT |
| `observe` | self-observation | BUILT |
| `runner` | doer/reviewer runner: draft pull requests, US-SPEC-11 | BUILT (see its README) |
| `describe` | self-description and the claims registry, US-SPEC-22 | BUILT (see its README) |
| `packs` | capability packs and the outbound guard, US-SPEC-21 | BUILT (see its README) |
| `packs/email` | email list pack, class B, US-SPEC-21 | BUILT (see its README) |
| `packs/social` (pack, outside core) | claim-backed public posting through the guard, US-SPEC-21 class B | BUILT (see `packs/social/README.md`) |
| `githubapp` | one-click GitHub App (manifest flow), short-lived installation tokens for the runner, door github-app-install | BUILT |
| `doors` | console doors: first-run key shown once, Cloudflare Access sign-in, paste-a-secret (Connect screen), US-SPEC-18/19 | BUILT (see `doors/doors.test.js`) |
| `elicit` | needs register, Ask cards, defaults with assumption log, read-back, readiness score, four-sweep ignorance audit, US-SPEC-16 | BUILT as a module (see `elicit/elicit.test.js`); wired into core/org as an opt-in tick step and token-guarded routes (`config.elicit.enabled`) |
| `console-l3` | operator console L3: fleet state, health, digest from one state, report cards with evidence and limits, objective-function guard, step budgets, US-SPEC-13 (L3 requirements R01-R06, R11) | BUILT as a module and served at `/api/console/fleet/*`; R12, R13 and the L2 service-level rows are NOT COVERED |
| `org` | composition root: one tick runs every loop, one handle serves every route; the Worker and Cloud Run call it | BUILT (see its README) |
| `codeloop`, `graph`, `tasks`, `router/calibration` | merge gate, blast radius, task runner, model probes | BUILT (see their READMEs) |
| rest | see [extraction/INVENTORY.md](../extraction/INVENTORY.md) | PLANNED |
| `ignorance/` | registry of known unknowns, red-team, inversion and pre-mortem passes, frontier of new questions | BUILT (see its README); org-tick step and model route BUILT |
| `principles/` | Principles register: tagline, glossary, owner directives with their enforcers; renders `docs/GLOSSARY.md` | US-SPEC-23, BUILT |
