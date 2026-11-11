# ultrastable/workers

**The code of Ultrastable: a self-governing development platform that runs on Cloudflare Workers.**

Coding agents are cheap. Managing them is not. Ultrastable runs the backlog, hands each item to the agent that fits, has a different agent verify every result, scores its own predictions, earns autonomy from a verified record, and interrupts a person only for a step that is both irreversible and identity-bound.

It runs today inside [QNFO](https://qnfo.org), which is its first and live customer: see the [case study](https://github.com/ultrastable/spec/blob/main/docs/qnfo-case-study.md).

> **License: free for non-commercial use. Commercial use requires a license and shares revenue with the Licensor.** See [LICENSE](LICENSE) (Ultrastable License v1.0) and [COMMERCIAL-TERMS.md](COMMERCIAL-TERMS.md). Source-available, not open source.

## Repositories

| Repository | What |
|---|---|
| **`ultrastable/workers`** (this one) | Code: the Cloudflare Worker tick, schema, bootstrapper, adapters, reference runtime |
| [`ultrastable/spec`](https://github.com/ultrastable/spec) | Architectural specifications and documentation: what a conforming implementation must do |
| [`ultrastable/license`](https://github.com/ultrastable/license) | Canonical license, commercial price list, FAQ |

## What is here

| Path | What | Status |
|---|---|---|
| [`worker/`](worker/) | The Worker: cron tick, D1 schema, tests. `src/tick.js` is the portable core (pure logic over a D1-shaped handle). | BUILT, 9 tests; the same tick runs QNFO's fleet |
| [`bootstrap/`](bootstrap/) | Idea file in, running organization out: plans the org, writes `org/`, creates D1, applies migrations, deploys the Worker | BUILT, 12 tests; `--apply` on a fresh account is not yet proven |
| [`agents/`](agents/), [`autonomy/`](autonomy/), [`ultrastable.json`](ultrastable.json), [`IDEA.md`](IDEA.md) | The template an org starts from: role instructions, autonomy policy (trust ladder, interrupt gate, limits), org config | BUILT |
| [`adapters/`](adapters/) | Same tick on Google Cloud Run + SQLite behind a D1-style handle | BUILT, 2 tests; not deployed on GCP |
| [`reference-python/`](reference-python/) | Stdlib-only Python reference runtime of the full control loop, CLI and dashboard | BUILT, 13 tests |
| [`extraction/`](extraction/) | Map of the 19 core workers still living in QNFO's fleet repository, and the plan to move them here | PLANNED |

## Quick start

Needs Node 22+ and Python 3.11+. No dependencies.

```bash
cd worker && npm test                       # the tick against an in-memory D1-shaped database
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
