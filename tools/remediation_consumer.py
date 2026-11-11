#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Remediation consumer: turns failure records into work-item payloads, once each. Input: JSONL, one record per line
{"source","kind","detail","at"}; state file remembers fingerprints (source|kind) so a recurring failure is one item, with a count.
Output: JSON list of item payloads ({id,title,owner_role,done_check,closing_probe}); records that do not parse are reported, not dropped.
  python tools/remediation_consumer.py --in failures.jsonl --state state.json [--owner operations]"""
from __future__ import annotations
import argparse, hashlib, json, sys
from pathlib import Path

def consume(lines, state, owner="operations"):
    items, bad = [], []
    for n, line in enumerate(lines, 1):
        if not line.strip(): continue
        try: r = json.loads(line); fp = f"{r['source']}|{r['kind']}"
        except (ValueError, KeyError, TypeError): bad.append(n); continue
        e = state.setdefault(fp, {"count": 0, "item": None}); e["count"] += 1
        if e["item"] is None:
            e["item"] = "REM-" + hashlib.sha256(fp.encode()).hexdigest()[:10]
            items.append({"id": e["item"], "title": f"{r['source']}: {r['kind']}", "owner_role": owner,
                          "done_check": f"{r['source']} no longer reports {r['kind']}", "closing_probe": f"no record for {fp} in the next run", "detail": str(r.get("detail", ""))[:300]})
    return items, bad

def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("--in", dest="inp", required=True); ap.add_argument("--state", required=True); ap.add_argument("--owner", default="operations")
    a = ap.parse_args(argv)
    sp = Path(a.state); state = json.loads(sp.read_text(encoding="utf8")) if sp.exists() else {}
    items, bad = consume(Path(a.inp).read_text(encoding="utf8").splitlines(), state, a.owner)
    sp.write_text(json.dumps(state, indent=2), encoding="utf8")
    print(json.dumps({"items": items, "unparsed_lines": bad}, indent=2))
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main())
