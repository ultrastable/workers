# Demos

**Ultrastable is the foundation for any autonomous system.**

Self-contained, no accounts, no secrets, no network calls.

| Demo | Run | Public | Status |
|---|---|---|---|
| Bootstrap simulator | open `apps/demos/public/bootstrap-simulator.html` through any static server, e.g. `cd apps/demos/public && python3 -m http.server` | yes (generic) | MODEL of the BUILT loop |
| Blocker cases | `apps/demos/public/bootstrap-cases.html` | yes | OBSERVED cases, names removed |

Engine: `apps/demos/public/engine.js`, deterministic, shared by browser and tests. Tests: `node --test apps/demos/test/*.test.mjs` (16 tests: determinism, no questions asked, every owner card has a default and probe, fallbacks, bundle under 100 KB, banned terms absent, worker routing). The banned-term list is `demos/publish.json`.

Public deploy is manual (script lives in the system-of-record repo). There is deliberately no workflow for it: Actions minutes on private repos are capped, so deploys of this kind are manual or run from a machine that holds the credential. Needs the two Cloudflare credentials (BG-35).
