<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# Cutover plan: QNFO workers repository to ultrastable/workers

Ultrastable is the foundation for any autonomous system. This plan replaces all code in the QNFO workers repository with code from this repository, with QNFO as the demo instance. Decision (Rowan, 2026-11-11): lift-and-shift will happen; plan and prepare now. Nothing here touches the QNFO repository's contents. Repositories stay private.

## Principles

1. **QNFO is configuration.** Names, account id, routes, owner contact, model ladder and secret binding names live in one instance file outside the shared code ([instance.example.json](instance.example.json), loader `tools/instance_config.mjs`). The separation guard (`core/test/no-qnfo.test.js`) stays green; the real QNFO instance file is kept in the QNFO deployment's private config, never here.
2. **Gates are tests, not sign-offs.** Each stage advances automatically when its parity gate passes. No person approves a stage. A step that is identity-bound or blocked by access is recorded in [GAPS.md](GAPS.md) with reason and workaround, and the stage proceeds on the workaround.
3. **Rollback at every stage**, and **a second route at every stage** (no single route).
4. **Additive until the last stage.** Old and new run side by side; traffic and scheduled work move one unit at a time; the old unit is only retired after a quiet period of passing probes.
5. **No new schedules above weekly** are created by this plan. The parity smoke is run on demand and by the existing tick, not by a new cron.

## Stages

| # | Stage | What happens | Gate (automatic) | Rollback | Second route |
|---|---|---|---|---|---|
| 0 | Inventory and contract (done in this change) | Parity map, shim list, instance schema, parity contract | `npm test` green incl. `tools/cutover.test.mjs` | Revert the PR | Map is also generated from `extraction/boundary.json` |
| 1 | Config extraction | Author the QNFO instance file from the live deployment's non-secret settings; validate with `instance_config.mjs` | Validator exits 0; guard green | Delete the instance file; nothing consumes it yet | File route and `ULTRASTABLE_INSTANCE_JSON` env route |
| 2 | Shadow deploy | Deploy ultrastable/workers as a separate Worker and D1 database named from the instance file, ticks disabled, no QNFO bindings that write | `parity_smoke.mjs` passes against old and shadow (read-only checks) | Delete the shadow Worker and database | Deploy via canonical-deploy workflow or direct Workers API (skill: ship-a-cloudflare-worker) |
| 3 | Data bridge | Copy the 22 core tables (boundary.json `core_tables`) into the new database through `tools/apply_migrations.py` plus a read-only export; QNFO tables stay | Row counts and checksum per table match at export time | Drop the shadow database; old database untouched (read-only export) | Export via D1 API or via the old worker's own query route |
| 4 | Unit-by-unit traffic move | Per [PARITY-MAP.md](PARITY-MAP.md) order: claims, router, kernel tick, deploy, loops. Route one unit's path prefix to the new Worker; old unit stays warm | Unit probes (parity contract plus unit tests) pass for 24 h and error rate is not above the old unit's | Point the route back at the old unit (one config change) | Route table has both targets; a failing target falls through to the other |
| 5 | Scheduler handover | Enable the new tick; disable the old tick for that unit only after the new tick has produced one scored cycle | New tick writes a tick row and its prediction is scored; no duplicate claims (`core/claims` unique) | Re-enable old tick, disable new | Tick can run from Cloudflare cron or from a manual `/tick` call |
| 6 | Shims retired | Each shim in [SHIMS.md](SHIMS.md) is replaced by its generic module or kept as QNFO instance overlay | Shim has zero callers in route logs for 7 days | Re-enable the shim | Overlay stays in the instance repo |
| 7 | Replace | The QNFO workers repository's code is replaced by this repository's code with the instance file as the only QNFO input, in the QNFO repository's own change path by its own PR | Full parity contract passes on the replaced deployment; `npm test` green | Revert the replacing commit; tag the old tree before the change | Replacement can be executed through GitHub API or a local push |
| 8 | Retire | Old workers deleted after 14 quiet days; data kept in the backup | Probes pass for 14 days | Redeploy from the pre-replace tag | Backup export is stored in R2 and in git bundle form |

## Execution rule

Execution of stages 1 to 8 is allowed once the previous stage's gate passes; it needs no sign-off. Stages that require the owner's identity (minting a Cloudflare or GitHub token, using the owner's account on the QNFO repository) are listed in [GAPS.md](GAPS.md) with the workaround (use the existing deploy bindings, `ORG_ADMIN_TOKEN` per `docs/ops/ORG-TOKEN.md`, or a PR the owner's repository automation merges). Deleting data without a backup is never done.

## Tools in this change

| Tool | Job |
|---|---|
| `tools/instance_config.mjs` | load and validate the instance file (file route, then env route); secret slots hold binding names only |
| `tools/parity_smoke.mjs` | run `parity-contract.json` against a from-side and a to-side, each with a list of base URLs |
| `tools/cutover.test.mjs` | tests for both (included in `npm test`) |

## Closing probe

`node tools/parity_smoke.mjs --from <old urls> --to <new urls>` exits 0 and `npm test` is green. Until a live deployment exists to probe, the probe is the test suite.
