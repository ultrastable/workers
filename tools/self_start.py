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
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bootstrap"))
import ladder  # noqa: E402  (cron_silent: the alarm fallback)

TITLE = "GATE: start Ultrastable on Ultrastable"
REQUIRED_TO_APPLY = ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID")
# repository secret name -> Worker secret name
WORKER_SECRETS = {"SELF_CONSOLE_TOKEN": "CONSOLE_TOKEN", "SELF_VCS_TOKEN": "VCS_TOKEN", "ANTHROPIC_API_KEY": "ANTHROPIC_API_KEY"}
STARTED = "org/started.json"


def present(env: dict, names) -> list[str]:
    return [n for n in names if env.get(n)]


def load_doors(root: Path) -> list[dict]:
    f = root / "self" / "doors.json"
    return json.loads(f.read_text(encoding="utf-8"))["prerequisites"] if f.exists() else []


def doors_section(prereq: dict) -> list[str]:
    lines = [f"### {prereq['what']}", "", "Do **any one** of these. They are ordered from least effort to most; the system uses whichever works first.", ""]
    for i, d in enumerate(prereq["doors"], 1):
        tag = "" if d["status"] == "built" else " (not built yet)"
        lines.append(f"{i}. **{d['id']}**, owner effort: {d['owner_effort']}{tag}. {d['how']}")
    return lines + [""]


def gate_issue_body(cards: list[dict], repo: str, missing_apply: list[str], doors: list[dict] | None = None, tried: list[dict] | None = None) -> str:
    lines = ["The organization starts itself as soon as one door below is done. Until then it stays in dry run and nothing is spent.",
             "A scheduled workflow (`self-start`) re-checks every few hours; nobody has to run anything. No door requires you to write code.", ""]
    for p in doors or []:
        if p["id"] == "cloudflare_access" and not missing_apply:
            continue  # the account credentials are already present
        lines += doors_section(p)
    if tried:  # what the loop already attempted on every door, so the owner sees the one thing left and never re-does a step
        lines += ["## What the system already tried", "", "| Door | Worked | Why |", "|---|---|---|"]
        lines += [f"| {t['door']} | {'yes' if t['ok'] else 'no'} | {str(t['reason']).replace(chr(124), '/')} |" for t in tried]
        lines.append("")
    lines += ["## Everything the bootstrapper recorded", "", "| Step | Why only you | If you do nothing | Closes when |", "|---|---|---|---|"]
    for c in cards:
        lines.append(f"| {c['what']} | {c['why_gated']} | {c['default_in_effect']} | `{c['closing_probe']}` |")
    lines += ["", "Closing probe: file_exists:" + STARTED, ""]
    return chr(10).join(lines)


def ensure_gate_issue(gh, cards, repo, missing_apply, doors=None, tried=None):
    body = gate_issue_body(cards, repo, missing_apply, doors, tried)
    existing = [i for i in gh.issues() if i["title"].startswith(TITLE) and i["state"].upper() == "OPEN"]
    if existing:
        if (existing[0].get("body") or "").strip() != body.strip():
            gh.edit_body(existing[0]["number"], body)
        return existing[0]["number"], "updated"
    return gh.create(f"{TITLE} ({len(cards)} owner steps)", body), "created"


def run_bootstrap(run, root: Path, apply: bool, tick_mode: str | None = None) -> int:
    cmd = [sys.executable, "bootstrap/bootstrap.py", "--apply" if apply else "--dry-run", "--idea", "self/IDEA.md", "--config", "self/ultrastable.json"]
    if tick_mode:
        cmd += ["--tick-mode", tick_mode]
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


def detect_existing(http, env: dict, root: Path, now: dt.datetime, trace: list | None = None) -> bool:
    """Door: any deployment of the Worker, made by any means. Its address comes from SELF_WORKER_URL or self/worker-url.txt.
    If /health answers ok the organization has started; write the record (names only) and let the loop closer close the gate."""
    f = root / "self" / "worker-url.txt"
    url = (env.get("SELF_WORKER_URL") or (f.read_text(encoding="utf-8").strip() if f.exists() else "")).rstrip("/")
    note = (lambda r: trace.append({"door": "existing-deployment", "ok": False, "reason": r})) if trace is not None else (lambda r: None)
    if not url.startswith("https://"):
        note("no https address in SELF_WORKER_URL or self/worker-url.txt")
        return False
    try:
        health = http(url + "/health")
    except Exception as e:
        note(f"/health unreachable ({type(e).__name__})")
        return False
    if not (health and health.get("ok")):
        note("/health answered but not ok")
        return False
    (root / "org").mkdir(exist_ok=True)
    rec = json.dumps({"at": now.isoformat(), "worker_url": url, "health_ok": True, "via": "existing-deployment"}, indent=2)
    (root / STARTED).write_text(rec + chr(10), encoding="utf-8")
    return True


WORKERS_URL = re.compile(r"https://[a-z0-9][a-z0-9.-]*\.workers\.dev", re.I)
PREVIEW_HOST = re.compile(r"^https://[0-9a-f]{8}-", re.I)  # per-version preview aliases are not the production address


def builds_url(check_runs: list[dict]) -> str | None:
    """The production workers.dev address a successful Workers Builds check run reports, or None. Reads GitHub only: no token of ours."""
    for c in check_runs:
        if "workers builds" not in (c.get("name") or "").lower():
            continue
        if c.get("status") != "completed" or c.get("conclusion") != "success":
            continue
        out = c.get("output") or {}
        text = " ".join(str(x or "") for x in (out.get("title"), out.get("summary"), out.get("text"), c.get("details_url")))
        urls = [u.rstrip(".").lower() for u in WORKERS_URL.findall(text)]
        urls = [u for u in urls if not PREVIEW_HOST.match(u)]
        if urls:
            return urls[0]
    return None


def detect_builds(http, gh_api, repo: str, root: Path, now: dt.datetime, trace: list | None = None) -> bool:
    """Door: a Workers Builds git-import deployment (Cloudflare dashboard, Import a repository). Cloudflare reports each build as a
    check run on the commit, so the address is read from GitHub with no Cloudflare token. If /health answers ok, record the start."""
    note = (lambda r: trace.append({"door": "workers-builds", "ok": False, "reason": r})) if trace is not None else (lambda r: None)
    try:
        runs = (gh_api(f"repos/{repo}/commits/main/check-runs?per_page=100") or {}).get("check_runs", [])
    except Exception as e:
        note(f"check runs unreadable ({type(e).__name__})")
        return False
    url = builds_url(runs)
    if not url:
        note("no successful Workers Builds check run with a workers.dev address on main")
        return False
    try:
        health = http(url + "/health")
    except Exception as e:
        note(f"/health unreachable ({type(e).__name__})")
        return False
    if not (health and health.get("ok")):
        note("/health answered but not ok")
        return False
    (root / "org").mkdir(exist_ok=True)
    rec = json.dumps({"at": now.isoformat(), "worker_url": url, "health_ok": True, "via": "workers-builds"}, indent=2)
    (root / STARTED).write_text(rec + chr(10), encoding="utf-8")
    return True


def record_attempt(root: Path, now: dt.datetime, doors: list[dict]) -> None:
    """Every run that does not start the org leaves org/start-attempt.json (names and reasons only; the self-start workflow commits it),
    so the gate issue and the next run read what each door did instead of guessing."""
    (root / "org").mkdir(exist_ok=True)
    f = root / "org" / "start-attempt.json"
    prev = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
    runs = int(prev.get("runs", 0)) + 1
    rec = {**{k: v for k, v in prev.items() if k not in ("at", "doors", "runs", "first_at")}, "first_at": prev.get("first_at", now.isoformat()), "at": now.isoformat(), "runs": runs, "doors": doors}
    f.write_text(json.dumps(rec, indent=2) + chr(10), encoding="utf-8")


def watch_tick(run, http, env: dict, root: Path, now: dt.datetime) -> dict | None:
    """Silent-cron fallback (issue #167). A Worker deployed in cron mode that answers /health but has run no tick after two periods
    (the cron registered and never fired, live trial 2026-11-12) is redeployed ticking from its Durable Object alarm, once.
    Reads org/started.json (written on apply with worker_url, tick_mode, tick_cron); a record without them is left alone."""
    f = root / STARTED
    try:
        rec = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    url = rec.get("worker_url")
    if rec.get("tick_mode") != "cron" or not url or rec.get("fallback"):
        return None
    try:
        health = http(url.rstrip("/") + "/health")
    except Exception as e:
        return {"checked": False, "reason": type(e).__name__}
    if not ladder.cron_silent(health, rec.get("at", ""), now, rec.get("tick_cron")):
        return {"checked": True, "silent": False}
    if [n for n in REQUIRED_TO_APPLY if not env.get(n)]:
        return {"checked": True, "silent": True, "fallback": "no deploy credentials in this run; the next run retries"}
    rc = run_bootstrap(run, root, True, "alarm")
    if rc == 0:
        rec.update({"tick_mode": "alarm", "fallback": {"from": "cron", "reason": "no tick observed", "at": now.isoformat()}})
        f.write_text(json.dumps(rec, indent=2) + "\n", encoding="utf-8")
    return {"checked": True, "silent": True, "fallback": "alarm" if rc == 0 else f"bootstrap exit {rc}"}


def start(run, http, gh, env: dict, root: Path, repo: str, now: dt.datetime, worker_dir="adapters/cloudflare", gh_api=None) -> dict:
    if (root / STARTED).exists():  # already started: nothing to do and nothing spent, except the silent-cron check
        return {"applied": False, "bootstrap_exit": 0, "gate_issue": None, "started": True, "secrets_set": [], "already": True, "tick_watch": watch_tick(run, http, env, root, now)}
    doors: list[dict] = []
    detected = detect_existing(http, env, root, now, doors)
    if detected:  # a deployment made by another door (dashboard git import, launcher claim): no token needed to verify it
        return {"applied": False, "bootstrap_exit": 0, "gate_issue": None, "started": True, "secrets_set": [], "via": "existing-deployment"}
    if gh_api and detect_builds(http, gh_api, repo, root, now, doors):  # git import by Workers Builds: no token needed
        return {"applied": False, "bootstrap_exit": 0, "gate_issue": None, "started": True, "secrets_set": [], "via": "workers-builds"}
    missing = [n for n in REQUIRED_TO_APPLY if not env.get(n)]
    apply = not missing
    if not gh_api:
        doors.append({"door": "workers-builds", "ok": False, "reason": "no GitHub API client in this run"})
    rc = run_bootstrap(run, root, apply)
    cards_path = root / "org" / "gate-cards.json"
    cards = json.loads(cards_path.read_text(encoding="utf-8")) if cards_path.exists() else []
    result = {"applied": apply, "bootstrap_exit": rc, "gate_issue": None, "started": False, "secrets_set": []}
    lad = root / "org" / "ladder.json"  # written by bootstrap/ladder.py during the run above
    if lad.exists():
        lj = json.loads(lad.read_text(encoding="utf-8"))
        doors += [{"door": "bootstrap-" + a["rung"], "ok": a["status"] == "ready", "reason": a["reason"]} for a in lj.get("attempts", [])]
    doors.append({"door": "bootstrap", "ok": apply and rc == 0, "reason": ("applied" if apply else "dry run: missing " + ", ".join(missing)) + f"; exit {rc}"})
    result["doors"] = doors
    record_attempt(root, now, doors)
    if cards or missing:
        result["gate_issue"] = ensure_gate_issue(gh, cards, repo, missing, load_doors(root), doors)
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
    tick_mode = "alarm" if (lad.exists() and json.loads(lad.read_text(encoding="utf-8")).get("tick_mode") == "alarm") else cfg["runtime"].get("tick_mode", "cron")
    record = {"at": now.isoformat(), "worker": name, "health_ok": ok, "secrets_set": result["secrets_set"], "applied": True,
              "worker_url": url, "tick_mode": tick_mode, "tick_cron": cfg["runtime"].get("tick_cron")}
    (root / "org").mkdir(exist_ok=True)
    if ok:
        (root / STARTED).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    else:
        prev = json.loads((root / "org" / "start-attempt.json").read_text(encoding="utf-8"))
        (root / "org" / "start-attempt.json").write_text(json.dumps({**prev, **record, "health": health}, indent=2) + "\n", encoding="utf-8")
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

    def gh_api(path):
        out = subprocess.run(["gh", "api", path], capture_output=True, text=True, check=True)
        return json.loads(out.stdout)

    r = start(run, http_json, Gh(a.repo), dict(os.environ), Path(a.root), a.repo, dt.datetime.now(dt.timezone.utc), gh_api=gh_api)
    print(json.dumps({k: v for k, v in r.items()}, indent=2))
    return 0 if (r["bootstrap_exit"] == 0) else 1


if __name__ == "__main__":
    sys.exit(main())
