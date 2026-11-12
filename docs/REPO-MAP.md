<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# Repository map: where the code is, where everything else is

Decision 2026-11-11. One rule: **code lives in one repository; documentation, specifications, license and business material live in others.** Scope: [SCOPE.md](../SCOPE.md).

## Where is the code? Here: `ultrastable/workers`

| Path | What | Language | Tests |
|---|---|---|---|
| `core/` | Portable core: the tick, the schema, the guided console. No cloud named. | JavaScript | `cd core && npm test` |
| `adapters/cloudflare/` | **First platform adapter**: Worker + cron + D1, serves the console | JavaScript | via core tests; `--apply` unproven |
| `adapters/gcp/`, `adapters/sqlite/` | Google Cloud Run adapter and the D1-shaped SQLite handle | JavaScript | `node --test adapters/gcp/test/*.js` |
| `bootstrap/` | Idea file in, running organization out | Python (stdlib) | `python -m unittest discover tests` |
| `agents/`, `autonomy/`, `ultrastable.json`, `IDEA.md` | Template every org starts from: roles, policy, config | Markdown/JSON | `tests/` |
| `runtimes/python/` | Reference runtime of the full loop: CLI, dashboard, Postgres store, connectors, org chart | Python (stdlib) | `cd runtimes/python && python -m unittest discover tests` |
| `products/gaplint/` | Open-loop linter for any repo | Python | `cd products/gaplint && python -m unittest discover tests` |
| `apps/demos/` | Static bootstrap simulator and blocker-case demos | JS/HTML | `node --test apps/demos/test/*.mjs` |
| `extraction/` | Plan and boundary map for moving the 19 core QNFO workers here (QNFO is the demo and first customer) | docs/JSON | |

Layering rule: `core/` imports nothing from `adapters/`; adapters import `core/`; `bootstrap/` writes config into an adapter. A new platform is a new directory under `adapters/`, see [adapters/README.md](../adapters/README.md).

## Where is everything else?

| Repository | Holds | Visibility |
|---|---|---|
| `ultrastable/workers` | All code (this repo) | private now, public after license review |
| `ultrastable/spec` | Architectural specifications (`US-SPEC-*`) and docs; replaces the patent drafts | private now, public later |
| `ultrastable/license` | Canonical license text, commercial terms, FAQ | private now, public later |
| `ultrastable/ultrastable` | System of record: roadmap, issues, ops, owner dashboard (`dashboard/`), instance generator (`foundation/`), site, outreach, social, brand, scripts | private |
| `ultrastable/business` | Business plan, funding, investor, Google/Cloudflare startup kits | private |
| `ultrastable/ip` | Historical patent drafts and evidence; not released | private |
| `ultrastable/site` | Marketing site worker | private until release |
| `ultrastable/docs`, `ultrastable/seed`, `ultrastable/platform` | Superseded: content moved to `spec` and `workers` | archive |

## Moved, left, and why

- **Moved here**: tick, schema, guided console, bootstrapper, template, GCP adapter, Python runtime (the newer `platform/core`, replacing the older copy), gaplint, bootstrap demos.
- **Left in `ultrastable/ultrastable`** (business/admin units, not product): owner dashboard (reads the monorepo's records), `foundation/` instance generator (copies the monorepo kernel layout; to be rewritten against this layout as item WRK-1), funding, outreach and social tooling (Capability Packs outside the core per SCOPE.md), `repo-live` demo (reads internal records), site deploy.
- **Removed from the bootstrapper**: the funding-registry side effect; funding is not a core function.
- **`platform/cloudflare-reference/`** (QNFO-derived migrations and scripts) stays in the system of record until extraction phase P2 replaces it with generic core migrations.

## Runtime layout after bootstrap

`bootstrap/bootstrap.py` renders `adapters/cloudflare/wrangler.jsonc` and "adapters/cloudflare/src/config.js" (both git-ignored) and points `migrations_dir` at `../../core/migrations`.
