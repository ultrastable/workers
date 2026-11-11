#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Bootstrap case library: turn a set of starting facts into routes and at most one owner card per blocker.

plan_cases(facts, library) -> {"applicable": [...], "cards": [...], "routes": [...], "assumed": [...]}
Unknown facts take the conservative default from cases.json and are listed in `assumed`, so the plan states what it
guessed. Cards with the same id are merged. Used by bootstrap.py (stage `cases`) and tests/test_cases.py.
"""
import json
from pathlib import Path

LIB = Path(__file__).resolve().parent / "cases.json"


def load_library(path=None):
    return json.loads(Path(path or LIB).read_text())


def plan_cases(facts, library=None):
    lib = library or load_library()
    merged, assumed = dict(lib["defaults"]), []
    for k in lib["defaults"]:
        if k not in (facts or {}):
            assumed.append(k)
    merged.update({k: v for k, v in (facts or {}).items()})
    applicable, cards, routes = [], {}, []
    for c in lib["cases"]:
        if all(merged.get(k) == v for k, v in c["when"].items()):
            applicable.append(c["id"])
            for r in c["routes"]:
                routes.append({"case": c["id"], **r})
            oc = c.get("owner_card")
            if oc:
                cards.setdefault(oc["id"], {**oc, "cases": []})["cases"].append(c["id"])
    return {"applicable": applicable, "cards": list(cards.values()), "routes": routes, "assumed": assumed}


def validate_library(lib):
    problems = []
    seen = set()
    for c in lib["cases"]:
        if c["id"] in seen:
            problems.append(f"{c['id']}: duplicate id")
        seen.add(c["id"])
        if not c["routes"]:
            problems.append(f"{c['id']}: no routes (a case must say how to proceed)")
        for r in c["routes"]:
            if not r.get("probe"):
                problems.append(f"{c['id']}: route without a closing probe")
        for k in c["when"]:
            if k not in lib["defaults"]:
                problems.append(f"{c['id']}: fact {k} has no default")
        oc = c.get("owner_card")
        if oc and not all(oc.get(k) for k in ("id", "what", "why", "default", "probe")):
            problems.append(f"{c['id']}: owner card needs id, what, why, default and probe")
    return problems


if __name__ == "__main__":
    import sys
    facts = json.loads(Path(sys.argv[1]).read_text()) if len(sys.argv) > 1 else {}
    print(json.dumps(plan_cases(facts), indent=2))
