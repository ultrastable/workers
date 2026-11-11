# Ultrastable platform

**The self-governing layer around the coding agents a team already uses.** Agents are cheap; managing them is not. Ultrastable runs the backlog, hands each item to the agent that fits, has a *different* agent verify every result, scores its own predictions, earns autonomy from a verified record, and interrupts a person only for steps that are both irreversible and identity-bound.


![status](https://img.shields.io/badge/tests-12%20passing-brightgreen) ![runtime](https://img.shields.io/badge/runtime-python%203.11%2B%20stdlib-blue) ![cloud](https://img.shields.io/badge/cloud-agnostic-lightgrey)

## What it does

| Loop | What happens each tick |
|---|---|
| **Reconcile** | Every item that leaves the active set must carry a disposition; a silent drop is an incident and is reopened. |
| **Dispatch** | The portfolio manager allocates execution slots across projects by weight and reserves a share (default 20%) for *plus* work. |
| **Act + verify** | A doer agent executes; a **different** agent independently verifies. A failed review reverts and retries; three failures file a root-cause item. |
| **Predict + score** | Each action logs a checkable prediction; due predictions are graded against metrics. |
| **Earn trust** | Reliability per (surface, action class) moves a ladder: observed → assisted → delegated → autonomous. Hidden failures found by audit demote. Widening scope beyond the cap needs an owner gate card. |
| **Plussing** | Every closed item proposes one improvement; the portfolio manager rebalances when fixes crowd improvements out. |
| **Self-amend** | A recurring failure pattern becomes a proposed rule amendment, reviewed and adopted with a version bump. |
| **Interrupt gate** | Irreversible **and** identity-bound actions (spend, sign, send as the owner) open an owner gate card instead of executing. The fleet continues with other work. |

Virtual staff: portfolio manager, project managers, product managers, staff (doers), reviewer, operations. Policy lives in [`ultrastable/data/policy.json`](ultrastable/data/policy.json).

## Run it in 30 seconds

```bash
python -m unittest discover -s tests          # 12 tests
python -m ultrastable demo --ticks 40         # simulated organization, no API keys needed
python -m ultrastable serve --seed-demo --auto-tick 5   # control-room dashboard on :8080
```

CLI: `init`, `tick`, `status`, `backlog`, `add`, `trust`, `gates`, `resolve`, `demo`, `serve`.

Honest status: the default demo agents are **simulated**; a first real-model proof exists ([docs/proof-real-agent.md](docs/proof-real-agent.md): Workers AI fixed a bug, verified by a separate test run, one toy task) (deterministic, seeded) so the loops can be demonstrated and tested anywhere. `WorkersAIAgent`, `CommandAgent` (any CLI agent) and `AnthropicAgent` are implemented; only the first has been run against a real task. See [docs/roadmap.md](docs/roadmap.md).

## Cloud-agnostic by construction

Core is Python standard library only: one container, one SQLite file, one HTTP port. Anything can drive the heartbeat (`POST /tick`).

| Target | Status |
|---|---|
| Google Cloud Run + Cloud Scheduler + Secret Manager | [`deploy/gcp/deploy.sh`](deploy/gcp/deploy.sh) (single-instance, demo-grade storage) |
| Cloudflare Workers + D1 (original runtime, runs QNFO today) | [`docs/architecture.md`](docs/architecture.md), seed repo |
| AWS / self-hosted | Container image; Postgres adapter on the roadmap |

Details: [architecture](docs/architecture.md), [deploy on Google Cloud](docs/deploy-gcp.md), [heritage and the QNFO transfer](docs/heritage.md), [security](docs/security.md).

## Layout

```
ultrastable/   engine.py (the loops) agents.py (adapters) store.py policy+config demo.py server.py cli.py data/
tests/         12 tests: gates, denial, review/revert, hidden-failure audit, amendments, trust math, HTTP
deploy/        gcp/ (Cloud Run + Scheduler)   Dockerfile at the root
```
