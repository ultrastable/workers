#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Merge a pull request only when CI has passed on its head commit. The second door for required checks.

Branch protection is a paid feature on private repositories, so the rule is code instead (failure F-002: a change was
merged before its tests had run). Every agent and person merges through this tool; it refuses, and says why, unless:

  - the pull request is not a draft and has no merge conflict, and
  - the `contract` job of the `self-hosting` workflow concluded `success` on the head commit (every pull request, docs-only included), and
  - the `test` job of the `ci` workflow concluded `success` on the pull request's head commit, or every changed file is
    on the docs-only list that the workflow skips (then there is nothing to run).

  python tools/safe_merge.py --repo OWNER/REPO --pr N [--apply]

Dry run by default. Exit 0 only when it merged (or, in a dry run, would merge).
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import subprocess
import sys

DOCS_ONLY = ["docs/*", "README.md", "CONTRIBUTING.md", "SECURITY.md", "COMMERCIAL-TERMS.md", "CITATION.cff"]


class Gh:
    def __init__(self, repo):
        self.repo = repo

    def _run(self, *args):
        return subprocess.run(["gh", *args], capture_output=True, text=True, check=True).stdout

    def pr(self, n):
        j = self._run("pr", "view", str(n), "-R", self.repo, "--json", "isDraft,mergeable,headRefOid,files,state")
        return json.loads(j)

    def check_conclusion(self, sha, name):
        j = self._run("api", f"repos/{self.repo}/commits/{sha}/check-runs", "--jq", ".check_runs")
        runs = [r for r in json.loads(j) if r["name"] == name]
        if not runs:
            return None
        newest = max(runs, key=lambda r: r.get("started_at") or "")
        return newest["conclusion"] if newest["status"] == "completed" else None

    def test_conclusion(self, sha):
        return self.check_conclusion(sha, "test")

    def merge(self, n):
        self._run("pr", "merge", str(n), "-R", self.repo, "--squash", "--delete-branch")


def decide(pr: dict, test_conclusion: str | None, contract_conclusion: str | None = "success") -> tuple[bool, str]:
    if pr["state"] != "OPEN":
        return False, f"pull request is {pr['state']}"
    if pr["isDraft"]:
        return False, "pull request is still a draft"
    if pr["mergeable"] == "CONFLICTING":
        return False, "merge conflict: rebase on main and run the tests again"
    if contract_conclusion != "success":  # F-002: the `contract` check (self-hosting record) is required on every pull request, docs-only included
        return False, "the contract check " + ("has not completed" if contract_conclusion is None else f"concluded {contract_conclusion}") + " on the head commit"
    paths = [f["path"] for f in pr["files"]]
    if paths and all(any(fnmatch.fnmatch(p, g) for g in DOCS_ONLY) for p in paths):
        return True, "docs-only change: the test job is skipped by design"
    if test_conclusion == "success":
        return True, "the test job passed on the head commit"
    if test_conclusion is None:
        return False, "the test job has not completed on the head commit: wait for it, do not merge on your own test run"
    return False, f"the test job concluded {test_conclusion} on the head commit"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo", required=True)
    ap.add_argument("--pr", type=int, required=True)
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args(argv)
    gh = Gh(a.repo)
    pr = gh.pr(a.pr)
    ok, why = decide(pr, gh.test_conclusion(pr["headRefOid"]), gh.check_conclusion(pr["headRefOid"], "contract"))
    print(("MERGE" if ok else "REFUSE") + ": " + why)
    if ok and a.apply:
        gh.merge(a.pr)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
