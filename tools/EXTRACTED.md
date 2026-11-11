<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# Core tools (extracted)

Stdlib-only command-line tools; each prints JSON or a table and has an exit code. Owner role operations unless noted. Tests: `tests/test_extracted_tools.py`, `tools/tools.test.mjs`. No tool runs a destructive step itself: revert and deploy commands are printed, migrations are idempotent.

| Tool | Job | Routes (no single route) |
|---|---|---|
| `deploy_probes.py` | probe a deploy; pass if any listed URL answers as expected | several URLs per probe, retries |
| `canary_revert.py` | keep or revert decision; prints the revert commands, runs none | probe results and error rate; no evidence means revert |
| `review_gate.py` | independent reviewer, evidence with numbers, checks green, protected-change reason | reviewer from the body line or the reviewers list |
| `fleet_graph.mjs` | blast radius of changed files (uses `core/graph`) | scan plus declared edges; `--changed` or `--git-diff` |
| `run-suites.mjs` | run every suite in `ops/suites.json`, report each | list file or `--only` |
| `release.py` | next version and release notes | `--log` file or git |
| `apply_migrations.py` | apply built migrations | `--sqlite` or `--d1` (wrangler) |
| `remediation_consumer.py` | failure records into one item per fingerprint | n/a (dedup by fingerprint) |
| `outline.py` | module outline for agents | JS and Python parsers |
| `extraction/product_boundary.mjs` | boundary check (already extracted) | n/a |
