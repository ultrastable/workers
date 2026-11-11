<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# Extraction lessons (2026-11-11)

1. **Clean-room by role, not copy.** The source fleet was not readable from the extraction session, so every module was written from its role in `boundary.json` and the specs. This forced real genericization: nothing was copied, so no tenant name could leak. Each README states NOT COVERED honestly.
2. **No single route is a testable rule.** Every module takes an ordered list of routes (merge hosts, edge sources, handlers, sinks, executors, transports) and has a test where the first route fails and the second serves. The last healthy route is never switched off (`router/calibration.js`).
3. **A probe must reach what it switched off.** The first calibration design could never recover a provider it had disabled, because the router skips disabled providers. Found by writing the recovery test; fixed by lifting the switch for the probe.
4. **Time is a port.** The owner-step watch first read an opened-time column that does not exist. It now records first-seen itself. Check that a table has the column before designing around it.
5. **Contract first.** The PR contract check needs an issue link (`Item: #N`) and a prediction in `<metric> <op> <number> within <N> h`. Open the item before the PR.
6. **Generated files.** Adding a module migration directory means registering it in `core/org/modules.js` and running `node tools/build_migrations.mjs`, or the drift test fails.
7. **Actions minutes.** Workflow templates are manual-only and live outside `.github/workflows/`; a test lints them and rejects `schedule:`.
8. **Honest checks.** An early draft of the PR-lane template hard-coded `checks: success`; it now reads the real check runs. A gate that assumes success is not a gate.
9. **Cutover is configuration plus a contract (2026-11-11).** Cutting over needs only two new artifacts: an instance file that holds every tenant value, and a parity contract run against both sides. Both are tested here with fake servers, so the gate logic is proven before any account exists. See `docs/cutover/PLAN.md`.
10. **A validator can enforce the no-single-route rule.** `instance_config.mjs` rejects an instance with fewer than two routes and rejects secret values in secret slots, so the rules are checked, not remembered.
