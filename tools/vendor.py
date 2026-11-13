#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""GAP-VENDOR-1: vendor and pin Ultrastable into any installation built on it. Generic: knows no downstream name.

  vendor.py --dest DIR [--subset] copy the tracked tree (or the subset), write DIR/VENDORED_FROM
  vendor.py --check DIR           verify DIR matches its VENDORED_FROM manifest (drift = exit 1)
  vendor.py --list                print the files that would be vendored

By default the whole tracked tree is vendored: tests also read files through data (a directive file naming its enforcers, the links
between documents), which no scan can see, so a subset can silently break a vendored test. `--subset` vendors only the CORE set
below. Dependencies are then discovered, not listed: every string literal in a vendored test (Python, JS, MJS)
that names a tracked file or directory is vendored too, repeated to a fixed point, so a test never reads a file that was left behind.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORE = ["core", "adapters", "agent-setup", "autonomy", "bootstrap", "org", "packs", "runtimes", "tools", "tests",
        "extraction", "agents", "ultrastable.json", "package.json", "LICENSE", "NOTICE", "SCOPE.md", "IDEA.md"]
SKIP_PARTS = {"node_modules", "__pycache__", ".git"}
TEST_RE = re.compile(r"(^|/)(test_[^/]*\.py|[^/]*\.test\.(m?js))$|(^|/)tests?/")
LIT_RE = re.compile(r"""['"`]([A-Za-z0-9_./@-]+(?:/[A-Za-z0-9_./@-]+)*)['"`]""")
MANIFEST = "VENDORED_FROM"


def tracked(root: Path) -> list[str]:
    out = subprocess.run(["git", "ls-files"], cwd=root, capture_output=True, text=True, check=True).stdout
    return [f for f in out.split("\n") if f and not (SKIP_PARTS & set(Path(f).parts))]


def head(root: Path) -> str:
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True, check=True).stdout.strip()


def select(root: Path, subset: bool = False) -> list[str]:
    files = tracked(root)
    if not subset:
        return sorted(files)
    fileset = set(files)
    chosen = {f for f in files if any(f == c or f.startswith(c + "/") for c in CORE)}
    dirs = {d for f in files for d in (str(p) for p in Path(f).parents) if d != "."}
    while True:
        added = set()
        for f in chosen:
            if not TEST_RE.search(f):
                continue
            try:
                text = (root / f).read_text(encoding="utf-8")
            except (UnicodeDecodeError, FileNotFoundError):
                continue
            for lit in LIT_RE.findall(text):
                for cand in {lit, posixpath.normpath(posixpath.join(posixpath.dirname(f), lit))}:
                    cand = cand.lstrip("./")
                    if cand in fileset and cand not in chosen:
                        added.add(cand)
                    elif cand in dirs:
                        added |= {g for g in files if g.startswith(cand + "/") and g not in chosen}
        if not added:
            return sorted(chosen)
        chosen |= added


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


# GAP-VENDOR-ORG (#182): rules in the source .gitignore that hide tracked data the vendored tests read. The source ignores
# local boot output under /org/ but tracks org/*.json; a vendored copy has no tracked/ignored split, so a push would drop them.
HIDING_RULES = {"/org/", "org/", "/org", "org"}


def fix_gitignore(dest: Path) -> None:
    g = dest / ".gitignore"
    if g.exists():
        kept = [ln for ln in g.read_text(encoding="utf-8").split(chr(10)) if ln.strip() not in HIDING_RULES]
        g.write_text(chr(10).join(kept), encoding="utf-8")


def vendor(root: Path, dest: Path, subset: bool = False) -> dict:
    files = select(root, subset)
    for f in files:
        t = dest / f
        t.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / f, t)
    fix_gitignore(dest)
    manifest = {"schema": "vendored-from/1", "source": "ultrastable/workers", "commit": head(root),
                "files": {f: sha(dest / f) for f in files}}
    (dest / MANIFEST).write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    return manifest


def check(dest: Path) -> list[str]:
    m = json.loads((dest / MANIFEST).read_text())
    bad = []
    for f, h in m["files"].items():
        p = dest / f
        if not p.exists():
            bad.append(f"missing {f}")
        elif sha(p) != h:
            bad.append(f"changed {f}")
    return bad


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dest")
    ap.add_argument("--check")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--subset", action="store_true", help="vendor only the CORE set plus discovered test dependencies")
    ap.add_argument("--root", default=str(ROOT))
    a = ap.parse_args(argv)
    if a.list:
        print("\n".join(select(Path(a.root), a.subset)))
        return 0
    if a.check:
        bad = check(Path(a.check))
        print("\n".join(bad) if bad else "vendored copy matches its manifest")
        return 1 if bad else 0
    if not a.dest:
        ap.error("--dest, --check or --list required")
    m = vendor(Path(a.root), Path(a.dest), a.subset)
    print(f"vendored {len(m['files'])} files at {m['commit'][:12]} into {a.dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
