# Bootstrapping: idea in, organization out

Goal: a person has an idea. Everything else starts from it, server-side, without that person operating anything.

## The chain

```
IDEA.md ─► read ─► detect ─► select ─► plan ─► write ─► provision ─► start ─► tick, tick, tick
 (human)   (seed)  creds,    model     roles,   org/     D1, Worker   cron     (server, forever)
                   tools     tier      backlog, files    deploy       armed
                                       gates
```

After `start`, the Worker's cron fires `runTick` every 10 minutes. Managers and staff are role rows in D1 with a model and a tick interval; each tick claims and dispatches items. Nothing needs a laptop.

## Stages

| Stage | Input | Output | If it fails |
|---|---|---|---|
| read | `IDEA.md`, `ultrastable.json`, `autonomy/policy.json` | parsed idea; policy validated (`validate_policy`) | missing IDEA.md: degrade to an empty charter and open a gate card; invalid policy: block |
| detect | environment | which connector secrets are set (never their values), which tools exist | each missing secret becomes a gate card with an `env:NAME` closing probe |
| select | budget in IDEA.md | model for doer, reviewer, manager | budget 0 uses the smallest tier |
| plan | the above | role instances (one project manager and product manager per outcome), kit backlog `KIT-0..6`, outcome items `OUT-n`, predictions | |
| write | plan | `org/` files, `worker/wrangler.jsonc`, `worker/src/config.js`, `org/seed.sql` | |
| provision | `--apply`, Cloudflare credentials | D1 created or found, migrations applied, seed SQL executed, Worker deployed | blocked: a backlog item `BOOT-PROVISION` with the exact error |
| start | | Worker cron armed | KIT-3 closes only when six complete ticks are seen in an hour |

The same command is safe to run repeatedly: seed rows use `INSERT OR IGNORE`, D1 creation looks for an existing database first.

## The tick (what the server does forever)

`reconcile` (disposition for every closed item, triggers become ready), `reap_claims`, `probe_gates` (owner-step cards close themselves when their probe passes), `score_predictions`, `accrue_trust`, `dispatch`, `check_plus_share`. A failing step is recorded and filed as work; the other steps still run. Each tick writes a four-line report to `tick_runs` and `/health`.

## Autonomy

Everything an agent may do is in `autonomy/policy.json`:

- **Surfaces** (repo, runtime, work tracker, internal chat, outreach, DNS, money, legal, secrets), each with a `max_permission` ceiling (`none`, `propose`, `execute`) and a `start_rung`.
- **Actions** per surface, each marked `reversible` and `identity_bound`. Irreversible but not identity-bound actions need a `reversible_path` (for example export to R2 before a destructive migration) or are denied.
- **The interrupt gate**: stop only for irreversible and identity-bound actions. Everything else runs and is verified.
- **Trust ladder**: observed, assisted, delegated, autonomous, self-directed, self-modifying, self-extending. Reliability per (surface, action class) = (verified + 0.5 x 2) / (outcomes + 2). With at least 10 outcomes, reliability 0.8 or more and no severe failure, `accrue_trust` opens a promotion item. Any hidden failure or silent drop demotes. A rung moves only when a different agent merges the PR changing the policy; the ledger never edits the policy itself. The rung can never exceed the surface ceiling, so money, legal, outreach and secrets stay below `execute` however trusted the fleet becomes.
- **Standing limits** that outrank trust: harness permission checks, safety refusals, the secret lock, outreach consent and opt-outs, the owner's override, other agents' live claims.

"Maximum permissions" means: allow everything a surface permits at its ceiling and deny only what the gate holds. `.claude/settings.json` does this for Claude Code (broad allow, deny list for force-push, repo deletion, `wrangler` deletes and secret writes). A server runner in an isolated container may run with permission prompts off; the deny list and the policy still apply, and `tests/test_policy.py` fails if a gated shell action lacks its deny rule.

## Agent instructions

`agents/AGENTS.md` is the single protocol; `CLAUDE.md` and `.github/copilot-instructions.md` point to it, so every agent family reads the same rules. `agents/roles/*.md` are the six role files. A role file changes only by reviewed PR, proposed by the operations role when a failure pattern repeats three times in seven days.

## Extending

Add a role: a file in `agents/roles/`, an entry in `ultrastable.json`, a PR. Add a surface: an entry in `autonomy/policy.json` with ceilings and actions, a PR. Other runtimes (GCP Cloud Run + Scheduler + Firestore, AWS, self-hosted) reimplement `provision` and `start`; the tick logic, schema and policy are runtime-neutral.

## Not done yet (tracked in the roadmap)

- Model calls: the tick dispatches items to roles; the executor that calls a model with the role file and the item (and reports back through outcomes) is the next increment (PL-7).
- Repo creation and protection (KIT-1) needs a GitHub token; the seed lists it as a gate card until provided.
- First real `--apply` against a Cloudflare account has not been run; only the dry run, the tick logic and the policy are tested.
