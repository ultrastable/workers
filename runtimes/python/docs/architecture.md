# Architecture

## Shape

```
                 ┌──────────── owner (direction, gate cards only) ────────────┐
                 │                                                             │
   CLI ──┐       ▼                                                             │
 dashboard ─► HTTP server ──► Engine.tick()  (11 guarded steps)                │
 Scheduler ─►  POST /tick         │                                            │
                                  ├─ Store (SQLite today; Postgres/Firestore adapter planned)
                                  ├─ Policy (autonomy/policy.json: surfaces, actions, ladder, limits)
                                  └─ Agent adapters: doer + reviewer (never the same)
                                       simulated | command (claude -p, codex exec, ...) | anthropic
```

## The tick (every step guarded; a failing step becomes a backlog item and the loop continues)

1. `reconcile` dispositions and readiness 2. `reap_claims` 3. `probe_gates` 4. `score_predictions` 5. `audit` (late discovery of hidden failures)
6. `accrue_trust` (ladder) 7. `portfolio` (allocation + plus reserve) 8. `product` (one plus per closed item)
9. `execute` (gate → claim → predict → do → independent verify → revert on fail) 10. `amend` 11. `plus_share` (rebalance)

## Portability contract

* Core: Python 3.11+ stdlib; no network at import; state in one database.
* Agents: `do(item) -> Result`, `verify(item, Result) -> (ok, evidence)`. Anything that can run a task and a check can be managed.
* Store: `Store.q/one/x/scalar` over SQL. Replace with a Postgres implementation of the same four methods.
* Heartbeat: any scheduler POSTs `/tick` (Cloud Scheduler, Cloudflare Cron Trigger, cron, GitHub Actions) or run `serve --auto-tick N`.

## Safety invariants (tested)

* An irreversible + identity-bound action is never executed by the loop; it opens a gate card (`test_irreversible_identity_bound_opens_gate_not_execution`).
* Denied actions are blocked with a disposition (`test_denied_action_is_blocked_with_disposition`).
* The doer never certifies its own work; `CommandAgent` without a check command refuses to self-certify.
* Promotions need more verified evidence at higher rungs and stop at `max_auto_rung` (default `autonomous`); beyond that is an owner gate card.
* Hidden failures that pass review are caught by a later audit and demote trust.
* Write endpoints require `ULTRASTABLE_TOKEN` when set.

## Known limits (not hidden)

* Demo agents are simulated. Real-agent adapters are unproven in production.
* SQLite on a single instance: no horizontal scale, no tenant isolation yet.
* Predictions use four built-in metrics; custom metrics are roadmap.
* No auth beyond a shared bearer token; no per-user identity yet.
