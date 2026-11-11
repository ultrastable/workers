#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Find the specifications' false BUILT labels: status lines that claim code which is not there.

A status line labelled BUILT must name, in backticks, at least one file or directory that exists in the code repository.
This is how Ultrastable finds its own untrue statements: each finding is a work item for the organization.

  python tools/spec_truth.py --spec-dir ../ultrastable-spec/specs --code-dir .            # report
  python tools/spec_truth.py --spec-dir ... --code-dir . --json                            # findings as JSON
  python tools/spec_truth.py --spec-dir ... --code-dir . --strict                          # exit 1 if any false BUILT

Stdlib only.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HEADING = re.compile(r"^#{1,4}\s+(?:\d+\.\s+)?Reference implementation status", re.I)
ANY_HEADING = re.compile(r"^#{1,4}\s+")
TICKS = re.compile(r"`([^`\n]+)`")
PATHLIKE = re.compile(r"^[\w.\-/\\]+$")


def candidate_paths(text: str) -> list[str]:
    out = []
    for t in TICKS.findall(text):
        t = t.strip().rstrip("/")
        if "/" in t and PATHLIKE.match(t) and not t.startswith(("http", "/", "~")):
            out.append(t)
        elif re.match(r"^[\w\-]+\.(js|mjs|py|sql|json|jsonc|md|yml|toml|sh|html)$", t):
            out.append(t)
    return out


def exists(code_dir, rel: str) -> bool:
    if isinstance(code_dir, (list, tuple)):
        return any(exists(d, rel) for d in code_dir)
    rel = rel.replace("\\", "/")
    if (code_dir / rel).exists():
        return True
    # a bare filename counts if exactly findable somewhere in the tree (specs often name files without the directory)
    if "/" not in rel:
        return any(code_dir.rglob(rel))
    return False


def findings(spec_dir: Path, code_dir) -> list[dict]:
    out = []
    for spec in sorted(spec_dir.glob("US-SPEC-*.md")):
        inside = False
        for n, line in enumerate(spec.read_text(encoding="utf-8").splitlines(), 1):
            if HEADING.match(line):
                inside = True
                continue
            if inside and ANY_HEADING.match(line):
                break
            if not inside:
                continue
            labels = [(m.start(), m.group(1)) for m in re.finditer(r"\b(BUILT|RUNNING|PLANNED)\b", line)]
            if not labels or min(labels)[1] != "BUILT":  # the first label in the line is its status
                continue
            paths = candidate_paths(line)
            missing = [p for p in paths if not exists(code_dir, p)]
            if not paths:
                out.append({"spec": spec.name, "line": n, "problem": "labelled BUILT but names no file", "text": line.strip()[:200]})
            elif len(missing) == len(paths):
                out.append({"spec": spec.name, "line": n, "problem": "labelled BUILT but none of the named paths exist", "missing": missing, "text": line.strip()[:200]})
            elif missing:
                out.append({"spec": spec.name, "line": n, "problem": "some named paths do not exist", "missing": missing, "text": line.strip()[:200]})
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--spec-dir", type=Path, required=True)
    ap.add_argument("--code-dir", type=Path, action="append", required=True, help="code repository (repeatable: also the specs repository for documents it names)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--strict", action="store_true")
    a = ap.parse_args(argv)
    f = findings(a.spec_dir, a.code_dir)
    if a.json:
        print(json.dumps(f, indent=2))
    else:
        print(f"{len(f)} BUILT status line(s) do not match the code")
        for x in f:
            print(f"  {x['spec']}:{x['line']}: {x['problem']}" + (f" {x['missing']}" if x.get("missing") else ""))
    return 1 if (a.strict and f) else 0


if __name__ == "__main__":
    raise SystemExit(main())
