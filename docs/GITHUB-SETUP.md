<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# GitHub setup checklist (owner)

Mirror of the "what to turn on, in order" section of `docs/github-free-org.md` in the spec repository; requirements are US-SPEC-21. Facts retrieved 2026-11-11. Commands marked untested were written from documentation and not run. Git Bash on Windows: write `gh api` paths without a leading slash.

## One command, dry run first

```
python tools/github_settings.py            # prints the gh api commands, changes nothing
python tools/github_settings.py --apply    # owner only: runs them
```

It covers steps 2 to 5 below. Steps 1 and 6 to 10 are UI or plan dependent.

## Checklist

1. Actions spending limit USD 0 with "Stop usage when budget limit is reached" on (Billing and licensing, Budgets and alerts). Verified in place on 2026-11-11: `gh api organizations/ultrastable/settings/billing/budgets` shows Actions, Git LFS, Codespaces, Packages at 0 with `prevent_further_usage: true`.
2. Default workflow token read-only; workflows may not approve pull requests (organization Settings, Actions, General). Observed today: `write`. Untested: `gh api -X PUT orgs/ultrastable/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false`.
3. Fork pull request workflows need approval from all outside contributors. Untested: `gh api -X PUT orgs/ultrastable/actions/permissions/fork-pr-contributor-approval -f approval_policy=all_external_contributors`.
4. Allow only GitHub-owned actions. Untested: `orgs/ultrastable/actions/permissions` with `allowed_actions=selected`, then `.../selected-actions` with `github_owned_allowed=true`.
5. Each repository: squash merge only, delete branch on merge, Discussions on. Untested: `gh api -X PATCH repos/ultrastable/workers -F delete_branch_on_merge=true -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false -F has_discussions=true`.
6. Create the Discussions category "Owner questions".
7. Create the Project board (Status, Program, Probe fields). Free-plan availability unverified.
8. Pages: public repositories only on the Free plan. Source `main` and `/docs`, or GitHub Actions.
9. Rulesets for the default branch (pull request required, check `test` required, no force pushes). Refused on private Free repositories (observed); apply when a repository goes public.
10. Before going public: secret history scan, secret scanning and push protection, fork approval, no `pull_request_target`, then step 9.

## Standing checks

```
python tools/workflow_lint.py                      # cost and security rules on every workflow (runs in ci.yml)
python tools/actions_budget.py --org ultrastable   # minutes against ops/actions-budget.json; exit 0 ok, 1 warn, 2 over
python tools/actions_budget.py --org ultrastable --emit-decision-card
```

The watchdog is meant to run from the Cloudflare tick, never from Actions. It reads only; disabling workflows at 100 percent is done by the caller from the `disable_workflows` list in its output.
