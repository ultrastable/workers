#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Start Ultrastable on Ultrastable, and keep trying until it has started. The start is itself a loop.

Each run (scheduled, on demand, and after each merge):

  1. Runs the bootstrapper in dry-run, or with --apply when the Cloudflare credentials are present.
  2. Reads the gate cards the bootstrapper wrote (`org/gate-cards.json`) and keeps exactly ONE open issue on the
     tracker that lists every step only the owner can take, each with the exact command, the default in effect and a
     closing probe. It updates that issue in place; it never files a second one.
  3. When the bootstrap applied and the Worker answers /health, puts the Worker's own secrets (by presence, values
     piped on stdin and never printed), writes `org/started.json` (names only) and closes the loop: the gate issue's
     probe `file_exists:org/started.json` passes and the loop closer closes it.

Nothing waits for a person to remember to run it: once the owner has set the secrets, the next scheduled run starts the
organization. Stdlib only. Secret values are read from the environment and never logged.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

TITLE = "GATE: start Ultrastable on Ultrastable"
REQUIRED_TO_APPLY = ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID")
# repository secret name -> Worker secret name
WORKER_SECRETS = {"SELF_CONSOLE_TOKEN": "CONSOLE_TOKEN", "SELF_VCS_TOKEN": "VCS_TOKEN", "ANTHROPIC_API_KEY": "ANTHROPIC_API_KEY"}
STARTED = "org/started.json"
HINTS = {
    "CLOUDFLARE_API_TOKEN": "dash.cloudflare.com/profile/api-tokens, Create Token, Custom token. Permissions (Account): Workers Scripts: Edit, D1: Edit, Account Settings: Read. Account resources: include only this account. No zone or user permissions.",
}


def present(env: dict, names) -> list[str]:
    return [n for n in names if env.get(n)]


def gate_issue_body(cards: list[dict], repo: str, missing_apply: list[str]) -> str:
    lines = ["The organization starts itself as soon as these are done. Until then it stays in dry run and nothing is spent.",
             "A scheduled workflow (`self-start`) re-checks every few hours; nobody has to run anything.", ""]
    if missing_apply:
        lines += ["## Add these repository secrets (identity-bound: only you can create them)", ""]
        for n in missing_apply:
            lines.append(f"- `{n}`: `gh secret set {n} -R {repo}`" + (f"
  - How to create it: {HINTS[n]}" if n in HINTS else ""))
        lines.append("")
    lines += ["## Everything the bootstrapper needs from you", "", "| Step | Why only you | If you do nothing | Closes when |", "|---|---|---|---|"]
    for c in cards:
        lines.append(f"| {c['what']} | {c['why_gated']} | {c['default_in_effect']} | `{c['closing_probe']}` |")
    lines += ["", "Closing probe: file_exists:" + STARTED, ""]
    return "\n".join(lines)


def ensure_gate_issue(gh, cards, repo, missing_apply):
    body = gate_issue_body(cards, repo, missing_apply)
    existing = [i for i in gh.issues() if i["title"].startswith(TITLE) and i["state"].upper() == "OPEN"]
    if existing:
        if (existing[0].get("body") or "").strip() != body.strip():
            gh.edit_body(existing[0]["number"], body)
        return existing[0]["number"], "updated"
    return gh.create(f"{TITLE} ({len(cards)} owner steps)", body), "created"


def run_bootstrap(run, root: Path, apply: bool) -> int:
    cmd = [sys.executable, "bootstrap/bootstrap.py", "--apply" if apply else "--dry-run", "--idea", "self/IDEA.md", "--config", "self/ultrastable.json"]
    return run(cmd, cwd=root).returncode


def worker_url(http, env: dict, worker_name: str) -> str | None:
    acct = env["CLOUDFLARE_ACCOUNT_ID"]
    out = http(f"https://api.cloudflare.com/client/v4/accounts/{acct}/workers/subdomain", {"Authorization": f"Bearer {env['CLOUDFLARE_API_TOKEN']}"})
    sub = (out or {}).get("result", {}).get("subdomain")
    return f"https://{worker_name}.{sub}.workers.dev" if sub else None


def http_json(url: str, headers: dict | None = None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310 (fixed https endpoints)
        return json.loads(r.read().decode())


def put_worker_secrets(run, root: Path, env: dict, worker_dir: str) -> list[str]:
    done = []
    for repo_name, worker_name in WORKER_SECRETS.items():
        value = env.get(repo_name)
        if not value:
            continue
        r = run(["npx", "wrangler", "secret", "put", worker_name], cwd=root / worker_dir, input=value)  # value on stdin only
        if r.returncode == 0:
            done.append(worker_name)
    return done


def start(run, http, gh, env: dict, root: Path, repo: str, now: dt.datetime, worker_dir="adapters/cloudflare") -> dict:
    missing = [n for n in REQUIRED_TO_APPLY if not env.get(n)]
    apply = not missing
    rc = run_bootstrap(run, root, apply)
    cards_path = root / "org" / "gate-cards.json"
    cards = json.loads(cards_path.read_text(encoding="utf-8")) if cards_path.exists() else []
    result = {"applied": apply, "bootstrap_exit": rc, "gate_issue": None, "started": False, "secrets_set": []}
    if cards or missing:
        result["gate_issue"] = ensure_gate_issue(gh, cards, repo, missing)
    if not apply or rc != 0:
        return result
    cfg = json.loads((root / "self" / "ultrastable.json").read_text(encoding="utf-8"))
    name = cfg["runtime"]["worker_name"]
    result["secrets_set"] = put_worker_secrets(run, root, env, worker_dir)
    url = worker_url(http, env, name)
    health = None
    if url:
        try:
            health = http(url + "/health")
        except Exception as e:  # a failed probe is recorded, never swallowed
            health = {"error": type(e).__name__}
    ok = bool(health and health.get("ok"))
    record = {"at": now.isoformat(), "worker": name, "health_ok": ok, "secrets_set": result["secrets_set"], "applied": True}
    (root / "org").mkdir(exist_ok=True)
    if ok:
        (root / STARTED).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    else:
        (root / "org" / "start-attempt.json").write_text(json.dumps({**record, "health": health}, indent=2) + "\n", encoding="utf-8")
    result["started"] = ok
    return result


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo", required=True)
    ap.add_argument("--root", default=".")
    a = ap.parse_args(argv)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from loop_closer import Gh  # same tracker client

    def run(cmd, cwd=None, input=None):
        return subprocess.run(cmd, cwd=cwd, input=input, text=True, capture_output=True)

    r = start(run, http_json, Gh(a.repo), dict(os.environ), Path(a.root), a.repo, dt.datetime.now(dt.timezone.utc))
    print(json.dumps({k: v for k, v in r.items()}, indent=2))
    return 0 if (r["bootstrap_exit"] == 0) else 1


if __name__ == "__main__":
    sys.exit(main())
