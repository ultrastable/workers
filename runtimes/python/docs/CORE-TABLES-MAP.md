# Core tables: product database map (issue #3)

The product database is the `Store` schema in `runtimes/python/ultrastable/store.py` (SQLite by default, Postgres through `runtimes/python/ultrastable/pg_store.py`). Each table in `extraction/boundary.json` `core_tables` has a home there. Nothing in `platform/core` reads `qnfo-audit`; `runtimes/python/tests/test_boundary.py` enforces both facts.

| QNFO core table | Product table |
|---|---|
| agent_issues, issue_triage | `items` (status, priority, disposition, blocker) |
| issue_lifecycle, decision_log | `events` |
| work_claims | `claims` |
| tick_runs | `tick_runs` |
| trust_ledger | `trust_ledger` |
| decision_predictions | `predictions` |
| decision_outcomes | `outcomes` |
| doctrine_proposals | `amendments` |
| owner_asks, human_actions | `gate_cards` |
| remediation_contracts, metric_registry, analytics_metric_triggers, failure_modes, spof_registry, belief_registry, blocker_redteam, capability_ledger, false_stop_register, control_registry | `registries` (kind = table name, key, JSON body; `Store.reg_put`, `Store.reg_list`) |

Data migration from `qnfo-audit` into a live product database needs a Cloud SQL instance (owner card #90). Default in effect: product database is the local SQLite file or CI Postgres. Closing probe for the live move: `DATABASE_URL` set on the deployed service and `SELECT count(*) FROM items` returns rows there.
