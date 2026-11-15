#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Requirement ids cited in code must exist in the specifications (US-19-R19).

Collects every requirement id the specifications define (`US-NN-RNN`, and the `US-NN-TNN` conformance tests) and every
id cited in the code repository, and reports citations of ids no specification defines.

  python tools/req_ids.py --spec-dir ../spec/specs --code-dir .            # report, exit 0
  python tools/req_ids.py --spec-dir ../spec/specs --code-dir . --strict   # exit 1 if any cited id is undefined
  python tools/req_ids.py ... --json

A test that writes a fixture specification inline is listed, with its reason, in tools/req-ids-fixtures.json.

Stdlib only.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REQ = re.compile(r"\bUS-(\d{2})-([RT])(\d{2,3})\b")
SKIP_DIRS = {".git", "node_modules", "__pycache__", "org", ".wrangler"}
CODE_EXT = {".js", ".mjs", ".py", ".sql", ".md", ".json", ".jsonc", ".yml", ".yaml", ".txt"}


def norm(m) -> str:
    return f"US-{m.group(1)}-{m.group(2)}{int(m.group(3)):02d}"


def defined_ids(spec_dir: Path) -> set[str]:
    out: set[str] = set()
    for spec in sorted(spec_dir.glob("US-SPEC-*.md")):
        for m in REQ.finditer(spec.read_text(encoding="utf-8")):
            out.add(norm(m))
    return out


def cited_ids(code_dir: Path) -> dict[str, list[str]]:
    """id -> sorted files that cite it."""
    out: dict[str, set[str]] = {}
    for p in sorted(code_dir.rglob("*")):
        if not p.is_file() or p.suffix not in CODE_EXT or any(part in SKIP_DIRS for part in p.relative_to(code_dir).parts):
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for m in REQ.finditer(text):
            out.setdefault(norm(m), set()).add(p.relative_to(code_dir).as_posix())
    return {k: sorted(v) for k, v in sorted(out.items())}


def fixture_files(code_dir: Path) -> set[str]:
    """Files listed in tools/req-ids-fixtures.json: their ids are fixture specifications inside a test."""
    f = code_dir / "tools" / "req-ids-fixtures.json"
    if not f.exists():
        return set()
    return set(json.loads(f.read_text(encoding="utf-8")).get("files", {}))


def undefined(spec_dir: Path, code_dir: Path, fixtures: bool = True) -> list[dict]:
    known = defined_ids(spec_dir)
    skip = fixture_files(code_dir) if fixtures else set()
    out = []
    for i, files in cited_ids(code_dir).items():
        real = [f for f in files if f not in skip]
        if i not in known and real:
            out.append({"id": i, "files": real})
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--spec-dir", type=Path, required=True)
    ap.add_argument("--code-dir", type=Path, required=True)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--strict", action="store_true")
    ap.add_argument("--no-fixtures", action="store_true", help="also report ids in the files tools/req-ids-fixtures.json lists")
    a = ap.parse_args(argv)
    if not any(a.spec_dir.glob("US-SPEC-*.md")):
        print(f"req_ids: no specification found in {a.spec_dir}", file=sys.stderr)
        return 2
    f = undefined(a.spec_dir, a.code_dir, fixtures=not a.no_fixtures)
    if a.json:
        print(json.dumps(f, indent=2))
    else:
        print(f"{len(f)} cited requirement id(s) are defined by no specification")
        for x in f:
            print(f"  {x['id']}: {', '.join(x['files'][:4])}" + (f" (+{len(x['files']) - 4} more)" if len(x["files"]) > 4 else ""))
    return 1 if (a.strict and f) else 0


if __name__ == "__main__":
    raise SystemExit(main())
