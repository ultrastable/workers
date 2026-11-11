#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Check that a pull request follows the self-hosting contract (agents/CONTRACT.md), whatever tool made it.

  python tools/selfhost_check.py --body-file pr.md --author someone --files "a.py,b.md" [--labels "x,y"]

Exit 0 when the pull request carries the record the contract asks for, 1 with the list of problems otherwise.
Bots that only bump dependencies are exempt by login. Stdlib only.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

PROTECTED = (
    "AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/", ".cursor/", "autonomy/policy.json", "SCOPE.md", "LICENSE",
    "COMMERCIAL-TERMS.md", "core/test/no-qnfo.test.js", "agents/CONTRACT.md", "tools/selfhost_check.py", "tools/spec_truth.py",
)
EXEMPT_AUTHORS = ("dependabot[bot]", "github-actions[bot]")
PREDICTION = re.compile(r"^[A-Za-z_][\w.]*\s*(>=|<=|>|<|=)\s*-?\d+(\.\d+)?\s+within\s+\d+\s*h\b", re.I)


def field(body: str, name: str) -> str | None:
    m = re.search(rf"^\s*[-*]?\s*\**{re.escape(name)}\**:\s*(.+?)\s*$", body, re.I | re.M)
    return m.group(1).strip() if m else None


def is_placeholder(v: str | None) -> bool:
    return v is None or not v.strip() or bool(re.fullmatch(r"[<\[].*[>\]]|todo|tbd|\.\.\.|-", v.strip(), re.I))


def protected(files: list[str]) -> list[str]:
    return [f for f in files if any(f == p or (p.endswith("/") and f.startswith(p)) for p in PROTECTED)]


def check(body: str, author: str, files: list[str], labels: list[str]) -> list[str]:
    if author.lower() in EXEMPT_AUTHORS:
        return []
    problems: list[str] = []
    item = field(body, "Item")
    if is_placeholder(item) or not re.search(r"(#\d+|github\.com/[^\s]+/issues/\d+)", item or ""):
        problems.append("Item: must link the issue this work belongs to (#123 or an issue URL). No issue, no work.")
    spec = field(body, "Spec")
    if is_placeholder(spec) or not re.search(r"US-\d{2}-R\d+|US-SPEC-\d+|n/a", spec or "", re.I):
        problems.append("Spec: must name requirement ids (for example US-08-R03 or US-SPEC-08) or say n/a with a reason.")
    pred = field(body, "Prediction")
    if is_placeholder(pred) or not (PREDICTION.match(pred or "") or re.match(r"n/a\b.{3,}", pred or "", re.I)):
        problems.append("Prediction: must be '<metric> <op> <number> within <N> h' (for example core_tests_passing >= 160 within 1 h) or 'n/a' with a reason.")
    ev = field(body, "Evidence")
    if is_placeholder(ev) or len(ev or "") < 12 or not re.search(r"\d", ev or ""):
        problems.append("Evidence: must quote real output (a test summary with numbers), not a description.")
    a, r = field(body, "Author"), field(body, "Reviewer")
    if is_placeholder(a):
        problems.append("Author: must name who or what wrote this (a tool and model, or a person).")
    if is_placeholder(r):
        problems.append("Reviewer: must name a different agent, model or person who reviews it.")
    elif not is_placeholder(a) and a.strip().lower() == r.strip().lower():
        problems.append("Reviewer: must differ from Author. Never review your own work.")
    hits = protected(files)
    if hits:
        why = field(body, "Protected-change")
        if is_placeholder(why) or len(why or "") < 12:
            problems.append("Protected-change: required because this touches protected paths (" + ", ".join(hits[:5]) + "); give the reason, and a human reviewer must approve.")
        if "human-reviewed" not in [l.lower() for l in labels] and "protected-change" not in [l.lower() for l in labels]:
            problems.append("Add the label 'protected-change': protected paths need a human reviewer (CODEOWNERS enforces it).")
    return problems


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--body-file", type=Path, required=True)
    ap.add_argument("--author", required=True)
    ap.add_argument("--files", default="", help="comma-separated changed paths")
    ap.add_argument("--labels", default="", help="comma-separated labels")
    a = ap.parse_args(argv)
    body = a.body_file.read_text(encoding="utf-8") if a.body_file.exists() else ""
    files = [f.strip() for f in a.files.split(",") if f.strip()]
    labels = [l.strip() for l in a.labels.split(",") if l.strip()]
    problems = check(body, a.author, files, labels)
    if problems:
        print("This pull request does not yet follow the self-hosting contract (agents/CONTRACT.md):", file=sys.stderr)
        for p in problems:
            print(" - " + p, file=sys.stderr)
        return 1
    print("self-hosting contract: ok" + (" (protected paths touched: human review required)" if protected(files) else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
