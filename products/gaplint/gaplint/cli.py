# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Command line: python3 -m gaplint [root] [--config FILE] [--json] [--rules GL001,GL003]."""
import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .config import load
from .rules import RULES


def run(root: Path, cfg):
    out = []
    for rid in cfg["rules"]:
        if rid not in RULES:
            raise SystemExit(f"unknown rule {rid}; known: {', '.join(sorted(RULES))}")
        out.extend(RULES[rid](root, cfg))
    return sorted(out, key=lambda f: (f.path, f.line, f.rule))


def main(argv=None):
    ap = argparse.ArgumentParser(prog="gaplint", description="Find open loops in a repository.")
    ap.add_argument("root", nargs="?", default=".")
    ap.add_argument("--config")
    ap.add_argument("--rules", help="comma-separated rule ids; overrides the config")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--version", action="version", version=__version__)
    a = ap.parse_args(argv)
    root = Path(a.root).resolve()
    cfg = load(root, a.config)
    if a.rules:
        cfg["rules"] = [r.strip() for r in a.rules.split(",") if r.strip()]
    findings = run(root, cfg)
    if a.json:
        print(json.dumps([f.as_dict() for f in findings], indent=2))
    else:
        for f in findings:
            print(f"{f.path}:{f.line}: {f.rule} {f.message}")
        print(f"gaplint {__version__}: {len(findings)} finding(s) in {root.name}")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
