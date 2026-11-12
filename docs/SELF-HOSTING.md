<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# Ultrastable improving Ultrastable

Decision 2026-11-11. The org `ultrastable` runs its own product on its own code base: an Ultrastable organization whose one job is to make `ultrastable/workers` match `ultrastable/spec`. This is the proof that the product works, and it is the second installation outside the reference fleet (extraction phase P4).

## 1. What we show

One claim, measured in public: **the specifications' unfinished list empties itself, one reviewed pull request at a time.**

North-star metric, computed from the specifications by `tools/spec_backlog.py`:

| Measure | Baseline 2026-11-11 |
|---|---|
| Capabilities the specs describe | 76 |
| BUILT here, with a named file and passing test | 27 |
| Running only in the reference fleet, no code here (to generalize) | 29 |
| PLANNED | 20 |
| **Remaining** (running-only + planned) | **49** |

The status tables lag the merged code (claims, router and deploy are merged but their rows are not updated yet), so the first honest drop comes from updating them with evidence.

The public view (the console in read-only form) shows five things and nothing else:

1. Remaining capabilities, falling.
2. Pull requests opened by agents, merged, and rejected by the reviewer (and why).
3. Predictions the system made about its own work and how many were right.
4. Money: spend against the daily and monthly cap, and **cost per merged pull request**.
5. Autonomy: where agents may act without a person, earned from recorded outcomes.

Not shown, because not the product: research, outreach, patents, business plans (`SCOPE.md`).

## 2. Where the engine lives: its own Cloudflare account

Yes: create a new Cloudflare account for `ultrastable`. Reasons, in order of weight:

1. **A token cannot reach what it should not.** The self-hosted org must never hold a credential for the reference fleet's account. A separate account makes that true by construction, not by promise.
2. **Spending is isolated.** Its bill, limits and alerts are its own.
3. **The Free plan is a hard cap.** On the Workers Free plan, usage beyond the daily limits fails instead of billing. On a paid plan, Cloudflare's budget alerts only email you; they do not stop usage.
4. **It proves reproducibility.** An outsider can repeat exactly this: a new account, one idea file, one command.

This is an identity-bound step (an account in your name and email). I cannot create it; see section 6.

## 3. Cost design (limits verified against Cloudflare's documentation, 2026-11-11)

| Resource | Free-plan limit | What it means here |
|---|---|---|
| Worker requests | 100,000/day; beyond it, error 1027 | One worker, a tick every 30 minutes (48 a day) and a few console views: far under |
| Worker CPU | 10 ms per invocation | **Risk to measure:** the tick must stay inside it; if not, the $5/month paid plan is the fallback |
| Cron triggers | 5 per account | Uses 1 |
| D1 | 5 million rows read and 100,000 rows written per day, 5 GB; over the limit, queries fail (enforced since 2026-09-01) | Ample for one organization |
| Workers AI | 10,000 neurons/day free; some large models need the paid plan; small open models are available free | The small rung (triage, review of diffs) |
| Paid plan | $5/month, no hard cap; budget alerts are informational only | Not used unless the CPU limit forces it |

Infrastructure cost therefore targets **$0**, with a hard stop. The cost that can spiral is model spend. It is capped in three independent places, so a bug in one does not open the tap:

| Layer | Cap | Mechanism |
|---|---|---|
| Router (`core/router`) | $0.50 per item, $1.50 per day, $30 per month (`self/ultrastable.json`, `spend_caps`) | Soft cap steers to a cheaper rung; hard cap refuses and files a decision card; kill switch stops all paid calls |
| Gateway | Same dollar limits | An AI Gateway spend limit in front of the paid provider blocks requests when the budget is exceeded |
| Provider | Prepaid credit, auto-reload off | When the credit is gone, calls fail. This is the last stop |

Habits that keep spend low (each is a requirement, not a hope):

- **No work, no model call.** The tick selects work by SQL; if nothing is ready it makes zero model calls.
- **Small model first.** Triage and review run on the free small rung; the paid medium rung does only the code change. The reviewer is always a different model family from the doer.
- **Small context.** The doer receives the spec section, the file and the failing test, not the repository.
- **Item budget.** An item that reaches its $0.50 cap stops and becomes a decision card; it does not continue silently.
- **One claim per item.** `core/claims` prevents two agents paying for the same work.
- **Loop breaker.** A remedy or deploy that fails twice stops and is replaced, not repeated (`core/deploy`; the kernel module covers metrics).
- **Measure.** Cost per merged pull request is a headline metric; a week-one baseline sets the targets. The $30 monthly cap is a ceiling, not a forecast.

## 4. How it starts improving itself

The first week is supervised, with autonomy at zero:

1. **Bootstrap.** `python bootstrap/bootstrap.py --apply --idea self/IDEA.md --config self/ultrastable.json` provisions the Worker, the D1 database and the cron in the new account. (Dry run today: 4 owner cards, none about patents, outreach or entities, because those belong to Capability Packs.)
2. **Seed the backlog.** `python tools/spec_backlog.py --spec-dir <spec>/specs --sql` loads one item per unfinished capability (49 today).
3. **Agents work through pull requests.** Doers open pull requests on `ultrastable/workers`; a different-family reviewer checks the diff and the named tests; **a person merges** until autonomy is earned.
4. **Earn autonomy per surface.** The trust ledger promotes a surface (for example "documentation pull requests") only from verified outcomes, by a reviewed change to the autonomy policy.
5. **Plussing.** 20% of capacity goes to improvement work, including improving the loops themselves.

### Protected paths: what the organization may never change by itself

`SCOPE.md`, `LICENSE`, `COMMERCIAL-TERMS.md`, `autonomy/`, `self/`, the QNFO separation guard and the spend caps are owner-reviewed (`.github/CODEOWNERS`). An agent that wants to change them files a decision card. This is the self-change protocol: changes are versioned, backed up, made through the normal path, verified by a probe the changing agent did not write, and reverted on a guard breach.

## 5. Risks, stated plainly

| Risk | Control |
|---|---|
| The tick exceeds the 10 ms CPU limit on the Free plan | Measure in week one; fall back to the $5 plan with the same three caps |
| Agents move the metric without the code (edit a status row to say BUILT) | A status change must name the file and a passing test; the reviewer verifies them; the metric counts only rows that pass a check in CI |
| Prompt injection through issues or pull-request text | Agents treat issue and PR text as data; no secret is ever in the model's context; protected paths need the owner |
| Model quality on the small rung is too low | The ladder lifts a rung only when recorded outcomes justify it; the cost ceiling still holds |
| Runaway cost | Three independent caps (section 3) |
| The demonstration is too narrow to impress | The metric is public and falling in real time; every row links to the merged pull request |

## 6. What only you can do (identity-bound), and what I do

| Step | Who |
|---|---|
| Create the new Cloudflare account (Free plan) and mint a scoped API token for it | You (account and identity) |
| Create a model-provider key with prepaid credit, auto-reload off; set the gateway spend limit | You (payment) |
| Give the org a GitHub token or app with only the `ultrastable` repositories | You |
| Set the three secrets as `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ANTHROPIC_API_KEY` | You, or the bootstrap workflow reads them |
| Everything else: dry run (done), backlog seeding, bootstrap `--apply`, first-week supervision, the public metrics view, status-table updates | Me and the organization |

## 7. Status

| Item | State |
|---|---|
| `self/IDEA.md`, `self/ultrastable.json` | BUILT; dry run passes with 4 owner cards |
| `tools/spec_backlog.py` | BUILT; 5 tests |
| Bootstrap `--idea` / `--config`; Capability Packs for patent, business, outreach and research cases | BUILT; 4 tests |
| Account, secrets, `--apply` | NOT DONE (owner steps above) |
| Doer runner (agents that actually write the pull requests) | PLANNED: next build |
| Read-only public metrics view (`tools/public_metrics.py`: remaining, agent PRs, predictions, spend, autonomy; JSON and static HTML) | BUILT; 6 tests; publishing it from the Worker needs the live account |
| Gateway spend limit, prepaid credit | NOT DONE (owner step) |
