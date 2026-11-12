#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""The read-only public metrics view of Ultrastable improving Ultrastable (docs/SELF-HOSTING.md section 1).

  python tools/public_metrics.py --repo ultrastable/workers [--spec-dir ../spec/specs] [--spend spend.json] [--predictions p.json]
                                 [--out org/public-metrics.json] [--html org/public-metrics.html]

Five measures, nothing else. Each is either computed from a real source or reported as null with the reason (never a guess):
  1. remaining_capabilities   from the specifications (tools/spec_backlog.py), needs --spec-dir
  2. agent_prs                pull requests on branches `agent/*`: opened, merged, rejected (closed unmerged), open
  3. predictions              {made, right} from a JSON file the Worker exports, needs --predictions
  4. money                    {spend_usd, cap_usd, cost_per_merged_pr_usd} from a JSON file the router exports, needs --spend
  5. autonomy                 surfaces by rung from autonomy/policy.json (start rungs; earned rungs need the trust ledger)
Stdlib only; reads GitHub through the gh CLI and writes only the two output files. The HTML is static, escaped and script-free.
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import subprocess
import sys
from pathlib import Path


def agent_pr_counts(prs: list[dict]) -> dict:
    mine = [p for p in prs if str(p.get("headRefName", "")).startswith("agent/")]
    merged = [p for p in mine if p.get("mergedAt") or str(p.get("state", "")).upper() == "MERGED"]
    open_ = [p for p in mine if str(p.get("state", "")).upper() == "OPEN"]
    rejected = [p for p in mine if str(p.get("state", "")).upper() == "CLOSED" and not p.get("mergedAt")]
    return {"opened": len(mine), "merged": len(merged), "rejected": len(rejected), "open": len(open_)}


def predictions_block(data: dict | None) -> dict | None:
    if not data:
        return None
    made, right = int(data.get("made", 0)), int(data.get("right", 0))
    return {"made": made, "right": right, "hit_rate": round(right / made, 3) if made else None}


def money_block(data: dict | None, merged: int) -> dict | None:
    if not data:
        return None
    spend = float(data.get("spend_usd", 0.0))
    return {"spend_usd": round(spend, 4), "cap_usd": data.get("cap_usd"), "within_cap": (spend <= float(data["cap_usd"])) if data.get("cap_usd") is not None else None,
            "cost_per_merged_pr_usd": round(spend / merged, 4) if merged else None}


def autonomy_block(policy: dict | None) -> dict | None:
    if not policy:
        return None
    by: dict[str, int] = {}
    for s in policy.get("surfaces", {}).values():
        r = str(s.get("start_rung"))
        by[r] = by.get(r, 0) + 1
    return {"surfaces": sum(by.values()), "by_start_rung": by}


def build(prs: list[dict], now: dt.datetime, remaining: dict | None = None, predictions: dict | None = None, spend: dict | None = None, policy: dict | None = None) -> dict:
    counts = agent_pr_counts(prs)
    nulls = {}
    out = {
        "generated_at": now.isoformat(),
        "remaining_capabilities": remaining,
        "agent_prs": counts,
        "predictions": predictions_block(predictions),
        "money": money_block(spend, counts["merged"]),
        "autonomy": autonomy_block(policy),
    }
    for k, why in (("remaining_capabilities", "pass --spec-dir"), ("predictions", "pass --predictions"), ("money", "pass --spend"), ("autonomy", "autonomy/policy.json not found")):
        if out[k] is None:
            nulls[k] = "not measured: " + why
    out["not_measured"] = nulls
    return out


def render_html(m: dict) -> str:
    e = html.escape
    rows = []

    def row(label, value):
        rows.append(f"<tr><th>{e(label)}</th><td>{e(str(value))}</td></tr>")

    rc = m["remaining_capabilities"]
    row("Remaining capabilities", rc["remaining"] if rc else m["not_measured"]["remaining_capabilities"])
    a = m["agent_prs"]
    row("Agent pull requests", f"{a['opened']} opened, {a['merged']} merged, {a['rejected']} rejected, {a['open']} open")
    p = m["predictions"]
    row("Predictions right", f"{p['right']} of {p['made']}" if p else m["not_measured"]["predictions"])
    mo = m["money"]
    row("Spend and cost per merged PR", f"${mo['spend_usd']} (cap {mo['cap_usd']}), per merged PR {mo['cost_per_merged_pr_usd']}" if mo else m["not_measured"]["money"])
    au = m["autonomy"]
    row("Autonomy", f"{au['surfaces']} surfaces, by start rung {au['by_start_rung']}" if au else m["not_measured"]["autonomy"])
    return ("<!doctype html><meta charset=utf-8><title>Ultrastable improving Ultrastable</title>"
            "<meta http-equiv=Content-Security-Policy content=\"default-src 'none'; style-src 'unsafe-inline'\">"
            "<style>body{font:16px system-ui;margin:2rem auto;max-width:42rem}th{text-align:left;padding-right:1rem}</style>"
            f"<h1>Ultrastable improving Ultrastable</h1><table>{''.join(rows)}</table><p>Generated {e(m['generated_at'])}</p>")


def gh_prs(repo: str) -> list[dict]:
    r = subprocess.run(["gh", "pr", "list", "-R", repo, "--state", "all", "--limit", "1000", "--json", "number,headRefName,state,mergedAt"], capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def _load(path):
    return json.loads(Path(path).read_text(encoding="utf-8")) if path and Path(path).exists() else None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo", required=True)
    ap.add_argument("--spec-dir")
    ap.add_argument("--spend")
    ap.add_argument("--predictions")
    ap.add_argument("--policy", default="autonomy/policy.json")
    ap.add_argument("--out", default="org/public-metrics.json")
    ap.add_argument("--html", default="org/public-metrics.html")
    a = ap.parse_args(argv)
    remaining = None
    if a.spec_dir:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import spec_backlog
        remaining = spec_backlog.summary(spec_backlog.collect(Path(a.spec_dir)))
    m = build(gh_prs(a.repo), dt.datetime.now(dt.timezone.utc), remaining, _load(a.predictions), _load(a.spend), _load(a.policy))
    for f, text in ((a.out, json.dumps(m, indent=2) + "\n"), (a.html, render_html(m))):
        Path(f).parent.mkdir(parents=True, exist_ok=True)
        Path(f).write_text(text, encoding="utf-8")
    print(json.dumps(m, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
