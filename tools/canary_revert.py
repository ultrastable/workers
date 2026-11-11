#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Canary decision after a deploy. Reads probe output (tools/deploy_probes.py JSON) and the deploy record, and decides:
keep | revert. Revert means: print the exact commands (git revert of the deploy commit, then redeploy); it never runs them
(a revert is a reviewed change on a protected branch). Two evidence routes: probe results AND an optional error-rate file;
either one failing is enough to revert, both missing is 'revert' (no evidence is not success).
  python tools/canary_revert.py --probes probes.json --commit <sha> [--errors errors.json --max-error-rate 0.05]
Exit 0 keep, 3 revert. Stdlib only."""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path

def decide(probes, errors=None, max_rate=0.05):
    reasons = []
    if probes is None:
        reasons.append("no probe evidence")
    elif not probes.get("ok"):
        reasons += [f"probe failed: {r['name']}" for r in probes.get("results", []) if not r.get("ok")] or ["probe failed"]
    if errors is not None:
        total, bad = errors.get("requests", 0), errors.get("errors", 0)
        if total and bad / total > max_rate:
            reasons.append(f"error rate {bad/total:.3f} > {max_rate}")
    return ("revert" if reasons else "keep"), reasons

def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("--probes"); ap.add_argument("--errors"); ap.add_argument("--commit", required=True); ap.add_argument("--max-error-rate", type=float, default=0.05)
    a = ap.parse_args(argv)
    load = lambda p: json.loads(Path(p).read_text(encoding="utf8")) if p else None
    try:
        probes = load(a.probes)
    except (OSError, ValueError):
        probes = None
    verdict, reasons = decide(probes, load(a.errors), a.max_error_rate)
    print(json.dumps({"decision": verdict, "reasons": reasons, "commands": [f"git revert --no-edit {a.commit}", "redeploy the reverted commit through the canonical deploy path"] if verdict == "revert" else []}, indent=2))
    return 3 if verdict == "revert" else 0

if __name__ == "__main__":
    sys.exit(main())
