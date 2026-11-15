#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Static cost and security lint for GitHub Actions workflows (US-SPEC-24, requirements US-24-R10..R19).

  python tools/workflow_lint.py                 # lints .github/workflows/*.yml
  python tools/workflow_lint.py path/a.yml ...  # lints the given files

Rules: W01 permissions, W02 concurrency (or a `# no-concurrency: <reason>` comment), W03 timeout-minutes on every job
(and <= 15), W04 no schedule trigger, W05 no pull_request_target, W06 actions pinned (no @main/@master/@HEAD, no bare ref),
W07 no secrets in a job reachable from a pull_request without a guard, W08 no macOS or Windows runners.
W09 (only with --require-sha, for public repositories, US-24-R18): every third-party action pinned to a full 40-character
commit SHA; a version tag is reported. `--sha-report` prints the unpinned actions and exits 0 (the measure, not the gate).
Stdlib only, line based (no YAML library); it expects the conventional two-space layout. Exit 0 clean, 1 findings.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

MAX_TIMEOUT = 15
COMMENT = re.compile(r"(^|\s)#.*$")
UNPINNED = re.compile(r"^\s*-?\s*uses:\s*['\"]?([^'\"\s@]+)(?:@(\S+?))?['\"]?\s*$")
GUARD = re.compile(r"workflow_dispatch|github\.event_name\s*==\s*'push'|head\.repo\.full_name\s*==\s*github\.repository")
SECRET = re.compile(r"secrets\.(?!GITHUB_TOKEN\b)\w+")


def _strip(lines):
    return [COMMENT.sub("", l).rstrip() for l in lines]


def _top_block(code, key):
    """Lines of a top-level key's block (without the key line)."""
    out, inside = [], False
    for l in code:
        if re.match(r"^['\"]?%s['\"]?\s*:" % re.escape(key), l):
            inside = True
            rest = l.split(":", 1)[1].strip()
            if rest:
                out.append(rest)
            continue
        if inside:
            if l and not l.startswith((" ", "\t")):
                break
            out.append(l)
    return out if inside else None


def _jobs(code):
    block = _top_block(code, "jobs") or []
    jobs, name, cur, indent = {}, None, [], None
    for l in block:
        m = re.match(r"^(\s+)([\w-]+):\s*$", l)
        if m and (indent is None or len(m.group(1)) == indent):
            indent = len(m.group(1))
            if name:
                jobs[name] = cur
            name, cur = m.group(2), []
        elif name is not None:
            cur.append(l)
    if name:
        jobs[name] = cur
    return jobs, (indent or 2)


def lint_text(text: str, name: str = "workflow.yml", require_sha: bool = False):
    raw = text.splitlines()
    code = _strip(raw)
    f = []

    def add(rule, msg):
        f.append(f"{name}: {rule} {msg}")

    on_block = " ".join(_top_block(code, "on") or _top_block(code, "true") or [])
    jobs, ji = _jobs(code)
    has_top_perm = _top_block(code, "permissions") is not None
    if not has_top_perm:
        missing = [j for j, b in jobs.items() if not any(re.match(r"^\s{%d}permissions\s*:" % (ji + 2), l) for l in b)]
        if missing or not jobs:
            add("W01", "no top-level `permissions:` (set `permissions: contents: read`)")
    if _top_block(code, "concurrency") is None and not any(re.search(r"#\s*no-concurrency:\s*\S", l) for l in raw):
        add("W02", "no top-level `concurrency:` (or a `# no-concurrency: <reason>` comment)")
    for j, b in jobs.items():
        if any(re.match(r"^\s{%d}uses\s*:" % (ji + 2), l) for l in b):
            continue  # reusable-workflow call: the callee carries the timeout
        m = next((re.match(r"^\s{%d}timeout-minutes\s*:\s*(\d+)\s*$" % (ji + 2), l) for l in b if re.match(r"^\s{%d}timeout-minutes\s*:" % (ji + 2), l)), None)
        if not m:
            add("W03", f"job `{j}` has no integer `timeout-minutes` (default would be 360)")
        elif int(m.group(1)) > MAX_TIMEOUT:
            add("W03", f"job `{j}` timeout-minutes {m.group(1)} exceeds {MAX_TIMEOUT}")
    allow_sched = any(re.search(r"#\s*allow-schedule:\s*\S", l) for l in raw)  # a stated reason and cost estimate
    if not allow_sched and (re.search(r"(^|[\s{,\[])schedule\s*:", on_block) or re.search(r"^\s+schedule\s*:", "\n".join(code), re.M)):
        add("W04", "`schedule:` trigger is forbidden (scheduled work runs from the Cloudflare tick)")
    if any("pull_request_target" in l for l in code):
        add("W05", "`pull_request_target` is forbidden")
    for l in code:
        m = UNPINNED.match(l)
        if not m or m.group(1).startswith(("./", "docker://")):
            continue
        if m.group(2) is None or m.group(2) in ("main", "master", "HEAD"):
            add("W06", f"action `{m.group(1)}` is not pinned to a tag or SHA (`@{m.group(2)}`)" if m.group(2) else f"action `{m.group(1)}` has no ref")
        elif require_sha and not re.fullmatch(r"[0-9a-f]{40}", m.group(2)):
            add("W09", f"action `{m.group(1)}@{m.group(2)}` is pinned to a tag, not to a full commit SHA")
    if re.search(r"\bpull_request\b(?!_target)", on_block):
        for j, b in jobs.items():
            body = "\n".join(b)
            if SECRET.search(body):
                ifs = [l for l in b if re.match(r"^\s{%d}if\s*:" % (ji + 2), l)]
                if not any(GUARD.search(l) for l in ifs):
                    add("W07", f"job `{j}` uses secrets in a workflow triggered by pull_request without a fork/event guard")
    for l in code:
        if re.search(r"runs-on\s*:.*\b(macos|windows)", l, re.I):
            add("W08", "macOS and Windows runners are forbidden (price per minute 10x and 1.7x Linux)")
    return f


def main(argv):
    flags = {a for a in argv if a.startswith("--")}
    unknown = flags - {"--require-sha", "--sha-report"}
    if unknown:
        print(f"workflow_lint: unknown option(s) {sorted(unknown)}")
        return 2
    paths = [Path(a) for a in argv if not a.startswith("--")] or sorted(Path(".github/workflows").glob("*.y*ml"))
    report = "--sha-report" in flags
    findings = []
    for p in paths:
        findings += lint_text(p.read_text(encoding="utf8"), p.as_posix(), require_sha=report or "--require-sha" in flags)
    if report:
        findings = [x for x in findings if " W09 " in x]
    for x in findings:
        print(x)
    print(f"workflow_lint: {len(paths)} file(s), {len(findings)} finding(s)" + (" not pinned to a commit SHA" if report else ""))
    return 0 if report else (1 if findings else 0)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
