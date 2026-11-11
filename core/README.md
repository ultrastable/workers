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
| (see issue tracker: label `extraction`) | | |
