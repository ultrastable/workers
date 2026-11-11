#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Review gate: a pull request may merge only when its record says a different party reviewed it and evidence is real.
Input: JSON {"body": "...", "author": "...", "reviewers": ["..."], "checks": "success|failure|pending", "labels": [...]} .
Rules: R1 Reviewer: line present and not the author (case-insensitive, same tool+model family counts as the author when written as 'same');
R2 Evidence: line has a number; R3 checks success; R4 a protected-change label needs a Protected-change: line.
Two inputs for the reviewer (body line OR the reviewers list): either may satisfy R1. Exit 0 pass, 1 fail. Stdlib only."""
from __future__ import annotations
import argparse, json, re, sys
from pathlib import Path

def field(body, name):
    m = re.search(rf"^{name}:\s*(.+)$", body or "", re.I | re.M)
    return m.group(1).strip() if m else ""

def gate(pr):
    body, author = pr.get("body", ""), (pr.get("author") or field(pr.get("body", ""), "Author")).lower()
    problems = []
    rev = field(body, "Reviewer")
    named = [r.lower() for r in pr.get("reviewers", [])]
    ok_body = bool(rev) and not re.search(r"pending|n/a|same|none", rev, re.I) and (not author or author not in rev.lower())
    ok_list = any(r != author for r in named)
    if not (ok_body or ok_list):
        problems.append("R1 no independent reviewer recorded")
    if not re.search(r"\d", field(body, "Evidence")):
        problems.append("R2 Evidence line has no numbers")
    if pr.get("checks") != "success":
        problems.append(f"R3 checks are {pr.get('checks', 'unknown')}")
    if "protected-change" in [l.lower() for l in pr.get("labels", [])] and not field(body, "Protected-change"):
        problems.append("R4 protected change without a Protected-change: reason")
    return problems

def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("--pr", required=True, help="JSON file")
    p = gate(json.loads(Path(ap.parse_args(argv).pr).read_text(encoding="utf8")))
    print(json.dumps({"pass": not p, "problems": p}, indent=2))
    return 1 if p else 0

if __name__ == "__main__":
    sys.exit(main())
