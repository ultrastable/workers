#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Release notes and version bump. Reads 'git log' subjects since a tag (or a given log file), groups by conventional prefix,
and proposes the next version: any 'BREAKING' -> major, 'feat' -> minor, else patch. Writes nothing unless --write.
  python tools/release.py --current 1.2.3 [--log log.txt] [--write CHANGELOG.md]
Two sources for commits: --log file, or git when absent. Stdlib only."""
from __future__ import annotations
import argparse, re, subprocess, sys

def bump(current, subjects):
    major, minor, patch = (int(x) for x in current.split("."))
    if any("BREAKING" in s for s in subjects): return f"{major+1}.0.0"
    if any(re.match(r"feat(\(|:)", s) for s in subjects): return f"{major}.{minor+1}.0"
    return f"{major}.{minor}.{patch+1}"

def notes(version, subjects):
    groups = {}
    for s in subjects:
        m = re.match(r"(\w+)(\([^)]*\))?!?:\s*(.+)", s)
        groups.setdefault(m.group(1) if m else "other", []).append(m.group(3) if m else s)
    out = [f"## {version}", ""]
    for k in sorted(groups):
        out += [f"### {k}"] + [f"- {x}" for x in groups[k]] + [""]
    return "\n".join(out)

def subjects_from(log, since):
    if log: return [l.strip() for l in open(log, encoding="utf8") if l.strip()]
    rng = f"{since}..HEAD" if since else "HEAD"
    r = subprocess.run(["git", "log", "--format=%s", rng], capture_output=True, text=True)
    if r.returncode: raise SystemExit("git log failed: " + r.stderr.strip())
    return [l for l in r.stdout.splitlines() if l.strip()]

def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("--current", required=True); ap.add_argument("--log"); ap.add_argument("--since"); ap.add_argument("--write")
    a = ap.parse_args(argv)
    subs = subjects_from(a.log, a.since)
    v = bump(a.current, subs); text = notes(v, subs)
    if a.write:
        old = open(a.write, encoding="utf8").read() if __import__("os").path.exists(a.write) else ""
        open(a.write, "w", encoding="utf8").write(text + "\n" + old)
    print(text)
    return 0

if __name__ == "__main__":
    sys.exit(main())
