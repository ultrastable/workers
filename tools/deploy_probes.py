#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Post-deploy probes. Config JSON: {"probes":[{"name","urls":[...],"expect_status":200,"expect_body":"substr"}]}.
Each probe lists one or more URLs (routes): it passes when ANY url answers as expected (no single route), after retries.
  python tools/deploy_probes.py --config ops/probes.json [--retries 3] [--delay 2]
Exit 0 all probes pass, 1 any failed. Output is JSON on stdout for tools/canary_revert.py. Stdlib only."""
from __future__ import annotations
import argparse, json, sys, time, urllib.request, urllib.error
from pathlib import Path

def fetch(url, timeout=10):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "ultrastable-probe"}), timeout=timeout) as r:
            return r.status, r.read(65536).decode("utf8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:  # network failure is a failed attempt, recorded below, never swallowed
        return 0, f"{type(e).__name__}: {e}"[:200]

def run_probe(p, retries=3, delay=2, get=fetch, sleep=time.sleep):
    attempts = []
    for i in range(max(1, retries)):
        for url in p["urls"]:
            status, body = get(url)
            ok = status == p.get("expect_status", 200) and p.get("expect_body", "") in body
            attempts.append({"url": url, "status": status, "ok": ok})
            if ok:
                return {"name": p["name"], "ok": True, "attempts": attempts}
        if i < retries - 1:
            sleep(delay)
    return {"name": p["name"], "ok": False, "attempts": attempts}

def main(argv=None, get=fetch, sleep=time.sleep):
    ap = argparse.ArgumentParser(); ap.add_argument("--config", required=True); ap.add_argument("--retries", type=int, default=3); ap.add_argument("--delay", type=float, default=2)
    a = ap.parse_args(argv)
    cfg = json.loads(Path(a.config).read_text(encoding="utf8"))
    res = [run_probe(p, a.retries, a.delay, get, sleep) for p in cfg["probes"]]
    print(json.dumps({"ok": all(r["ok"] for r in res), "results": res}, indent=2))
    return 0 if all(r["ok"] for r in res) else 1

if __name__ == "__main__":
    sys.exit(main())
