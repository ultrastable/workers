#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Apply the safe GitHub settings of docs/GITHUB-SETUP.md (US-SPEC-21, US-21-R30..R34) with `gh api`.

  python tools/github_settings.py                       # DRY RUN (default): prints the gh api commands, changes nothing
  python tools/github_settings.py --apply               # runs them
  python tools/github_settings.py --org ultrastable --repos workers spec license .github

Only the owner runs --apply. Paths have no leading slash (Git Bash would rewrite it). Stdlib only.
Not handled here (UI or paid plan): the Actions spending limit / budget (billing pages), Pages source, Projects, rulesets on private repos.
"""
from __future__ import annotations

import argparse
import shlex
import subprocess
import sys

DEFAULT_REPOS = ["workers", "spec", "license", ".github"]


def commands(org: str, repos: list[str]) -> list[list[str]]:
    c = [
        # Org: allow Actions, but only GitHub-owned and verified actions, and require full-SHA pinning is left off (tags allowed).
        ["gh", "api", "-X", "PUT", f"orgs/{org}/actions/permissions", "-f", "enabled_repositories=all", "-f", "allowed_actions=selected"],
        ["gh", "api", "-X", "PUT", f"orgs/{org}/actions/permissions/selected-actions", "-F", "github_owned_allowed=true", "-F", "verified_allowed=false"],
        # Org: default GITHUB_TOKEN read-only, workflows cannot approve PRs.
        ["gh", "api", "-X", "PUT", f"orgs/{org}/actions/permissions/workflow", "-f", "default_workflow_permissions=read", "-F", "can_approve_pull_request_reviews=false"],
        # Org: fork PRs from every outside contributor need approval before a workflow runs.
        ["gh", "api", "-X", "PUT", f"orgs/{org}/actions/permissions/fork-pr-contributor-approval", "-f", "approval_policy=all_external_contributors"],
    ]
    for r in repos:
        c.append(["gh", "api", "-X", "PATCH", f"repos/{org}/{r}", "-F", "delete_branch_on_merge=true", "-F", "allow_squash_merge=true",
                  "-F", "allow_merge_commit=false", "-F", "allow_rebase_merge=false", "-F", "has_discussions=true", "-F", "has_wiki=false"])
    return c


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--org", default="ultrastable")
    ap.add_argument("--repos", nargs="*", default=DEFAULT_REPOS)
    ap.add_argument("--apply", action="store_true", help="actually run the commands (default is a dry run)")
    a = ap.parse_args(argv)
    cmds = commands(a.org, a.repos)
    print(f"# {'APPLY' if a.apply else 'DRY RUN (nothing is changed; pass --apply to run)'}: {len(cmds)} command(s)")
    rc = 0
    for cmd in cmds:
        print(shlex.join(cmd))
        if a.apply:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            print(f"  -> exit {r.returncode} {(r.stderr or r.stdout).strip()[:200]}")
            rc = rc or r.returncode
    return rc


if __name__ == "__main__":
    sys.exit(main())
