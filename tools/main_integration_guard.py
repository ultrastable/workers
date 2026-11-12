#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Catch two individually green pull requests that break main together (issue #156, failure seen in #146).

Each pull request is tested against the main it branched from, so two green PRs can still conflict in meaning (a new table
versus a pack guard). This tool tests the combination in a scratch worktree, without touching the working copy:

  python tools/main_integration_guard.py --repo-dir . --base origin/main --head origin/pr-a --head origin/pr-b
  python tools/main_integration_guard.py --repo-dir . --base origin/main --main-only      # post-merge check of main itself

For each head it merges onto base and runs the suites in ops/suites.json (or --cmd). If the full combination fails it
names the smallest failing set: a single head (that PR is red on today's main) or the first pair that fails together.
Exit 0 when green, 1 when a break is found, 2 when the tool itself could not run. A needed workflow change is not made here
(.github/ is protected): wire this tool into a workflow by a protected change, or run it from the tick as a probe.
"""
from __future__ import annotations

import argparse
import itertools
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def git(repo, *args, check=True):
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {(r.stderr or r.stdout).strip()[:300]}")
    return r


def shell(cmd, cwd):
    r = subprocess.run(cmd, shell=True, cwd=str(cwd), capture_output=True, text=True)
    return r.returncode == 0, (r.stdout + r.stderr).strip()[-400:]


def suites(repo, cmd=None):
    if cmd:
        return [{"name": "cmd", "cmd": cmd}]
    f = Path(repo) / "ops" / "suites.json"
    return json.loads(f.read_text(encoding="utf8")) if f.exists() else []


def try_set(repo, base, heads, run=shell, cmd=None):
    """Merge `heads` onto `base` in a scratch worktree and run the suites. Returns {ok, stage, detail}."""
    tmp = Path(tempfile.mkdtemp(prefix="integration-guard-"))
    wt = tmp / "wt"
    try:
        git(repo, "worktree", "add", "--detach", str(wt), base)
        for h in heads:
            m = git(wt, "-c", "user.name=guard", "-c", "user.email=guard@example.invalid", "merge", "--no-ff", "--no-edit", h, check=False)
            if m.returncode != 0:
                git(wt, "merge", "--abort", check=False)
                return {"ok": False, "stage": f"merge {h}", "detail": (m.stdout + m.stderr).strip()[-300:]}
        for s in suites(wt, cmd):
            ok, out = run(s["cmd"], wt)
            if not ok:
                return {"ok": False, "stage": f"suite {s['name']}", "detail": out}
        return {"ok": True, "stage": "all suites", "detail": ""}
    finally:
        git(repo, "worktree", "remove", "--force", str(wt), check=False)
        shutil.rmtree(tmp, ignore_errors=True)


def guard(repo, base, heads, run=shell, cmd=None):
    """Full combination first; on failure, narrow to a single head or the first failing pair."""
    base_res = try_set(repo, base, [], run, cmd)
    if not base_res["ok"]:
        return {"ok": False, "culprit": [], "why": "base is red on its own", **base_res}
    full = try_set(repo, base, heads, run, cmd)
    if full["ok"]:
        return {"ok": True, "culprit": [], "why": "base plus every head is green", **full}
    for h in heads:
        r = try_set(repo, base, [h], run, cmd)
        if not r["ok"]:
            return {"ok": False, "culprit": [h], "why": "head fails alone on current base", **r}
    for a, b in itertools.combinations(heads, 2):
        r = try_set(repo, base, [a, b], run, cmd)
        if not r["ok"]:
            return {"ok": False, "culprit": [a, b], "why": "each is green alone, together they break", **r}
    return {"ok": False, "culprit": list(heads), "why": "only the full combination breaks", **full}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo-dir", default=".")
    ap.add_argument("--base", default="origin/main")
    ap.add_argument("--head", action="append", default=[])
    ap.add_argument("--main-only", action="store_true")
    ap.add_argument("--cmd", help="one command instead of ops/suites.json")
    a = ap.parse_args(argv)
    if not a.head and not a.main_only:
        print("give --head at least once, or --main-only", file=sys.stderr)
        return 2
    try:
        res = guard(a.repo_dir, a.base, [] if a.main_only else a.head, cmd=a.cmd)
    except RuntimeError as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 2
    print(json.dumps(res, indent=2))
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
