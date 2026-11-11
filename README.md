# ultrastable/workers

**The code of Ultrastable: a self-governing development platform that runs on Cloudflare Workers.**

Coding agents are cheap. Managing them is not. Ultrastable runs the backlog, hands each item to the agent that fits, has a different agent verify every result, scores its own predictions, earns autonomy from a verified record, and interrupts a person only for a step that is both irreversible and identity-bound.

It runs today inside [QNFO](https://qnfo.org), which is its first and live customer: see the [case study](https://github.com/ultrastable/spec/blob/main/docs/qnfo-case-study.md).

> **License: free for non-commercial use. Commercial use requires a license and shares revenue with the Licensor.** See [LICENSE](LICENSE) (Ultrastable License v1.0) and [COMMERCIAL-TERMS.md](COMMERCIAL-TERMS.md). Source-available, not open source.

## Scope

Ultrastable is for a person who can say what they want but is not a coder and does not know what they do not know. It works out what it needs to know, asks in plain words, writes its own specifications and charters, and builds and runs the system under full project-management discipline (initiating, planning, executing, monitoring, closing; predictive, agile or hybrid). By default it does **not** write business plans, file patents or trademarks, give legal or financial advice, or run marketing or outreach; those are opt-in Capability Packs outside the core. The boundary and the scope test are in [SCOPE.md](SCOPE.md).

## Repositories

| Repository | What |
|---|---|
| **`ultrastable/workers`** (this one) | Code: the Cloudflare Worker tick, schema, bootstrapper, adapters, reference runtime |
| [`ultrastable/spec`](https://github.com/ultrastable/spec) | Architectural specifications and documentation: what a conforming implementation must do |
| [`ultrastable/license`](https://github.com/ultrastable/license) | Canonical license, commercial price list, FAQ |

## What is here

| Path | What | Status |
|---|---|---|
| [`core/`](core/) | Portable core: the tick, schema, guided console. Pure logic over a D1-shaped handle, no cloud named. | BUILT, 13 tests; the same tick runs QNFO's fleet |
| [`adapters/cloudflare/`](adapters/cloudflare/) | **First platform adapter**: Worker, cron, D1. Local demo: `cd adapters/cloudflare && npm run demo` (key: demo). | BUILT; `--apply` on a fresh account not yet proven |
| [`adapters/gcp/`](adapters/gcp/) | Google Cloud Run + SQLite behind the same handle; documented path to Cloud SQL and Vertex AI | BUILT, 3 tests; not deployed on GCP |
| [`bootstrap/`](bootstrap/) | Idea file in, running organization out: plans the org, writes `org/`, creates D1, applies migrations, deploys the Worker | BUILT, 12 tests; `--apply` on a fresh account is not yet proven |
| [`agents/`](agents/), [`autonomy/`](autonomy/), [`ultrastable.json`](ultrastable.json), [`IDEA.md`](IDEA.md) | The template an org starts from: role instructions, autonomy policy (trust ladder, interrupt gate, limits), org config | BUILT |
| [`runtimes/python/`](runtimes/python/) | Stdlib-only Python reference runtime: full loop, CLI, dashboard, Postgres store, connectors | BUILT, 44 tests |
| [`products/gaplint/`](products/gaplint/) | Open-loop linter for any repo | BUILT, 12 tests |
| [`apps/demos/`](apps/demos/) | Static bootstrap simulator and blocker-case demos | BUILT |
| [`extraction/`](extraction/) | Map of the 19 core workers still living in QNFO's fleet repository, and the plan to move them here | PLANNED |

## Quick start

Needs Node 22+ and Python 3.11+. No dependencies.

```bash
cd core && npm test                       # the tick against an in-memory D1-shaped database
python bootstrap/bootstrap.py --dry-run     # idea file in, org/ plan out; nothing leaves your machine
python -m unittest discover tests           # bootstrapper and policy tests
node --test adapters/gcp/test/*.js          # the same tick behind an HTTP service
```

`--apply` provisions Cloudflare resources and needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment. Details in [docs/seed.md](docs/seed.md) and [docs/bootstrapping.md](docs/bootstrapping.md).

## Honest status

Proven by tests: the tick, the trust ledger, prediction scoring, plussing, claims, the bootstrapper's dry run, the GCP adapter against SQLite. Running in production: the tick inside QNFO. **Not proven:** a fresh-account `--apply` end to end; a second installation outside QNFO's fleet (extraction phase P4); GCP deployment; Postgres dialect; real-model staff roles outside QNFO.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions are licensed under the same terms and give the Licensor the right to relicense them commercially (LICENSE Section 11).

Licensor: Rowan Brad Quni-Gudzinas. Contact: rowan.quni@qnfo.org.
