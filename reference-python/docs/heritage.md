# Heritage: what transferred from QNFO

Ultrastable generalizes patterns that run the QNFO research fleet (customer zero) on Cloudflare. The knowledge moved; the code here is a clean-room portable core, not a copy of the fleet.

| QNFO practice | Ultrastable component |
|---|---|
| Fleet tick (cron heartbeat, "PID 1 never dies") | `Engine.tick()`: 11 guarded steps |
| Portfolio and program managers, constraint focus | `portfolio` step, per-project allocation |
| Work claims, dispositions, "no silent drops" | `claims`, `reconcile`, silent-drop outcomes |
| Learn-apply-verify, predictions scored against metrics | `predictions`, `score_predictions`, hit-rate KPI |
| Trust by surface and action class; narrow interrupt gate | `trust_ledger`, ladder, `gate_cards` |
| Plussing (protected improvement budget) | `product` + `plus_share` steps |
| Self-change protocol (versioned, reviewed rule changes) | `amendments`, rules version |
| Never self-review | doer/reviewer separation in `agents.py` |
| `agent_issues`, remedy efficacy | `events` audit trail, root-cause `FIX-*` items |

Provenance and IP: the originating design and its history are recorded in the `ip` repo (invention disclosure, evidence log, IP register). Ownership assignment from the author to the company is an open item tracked in that repo. [LAWYER]
