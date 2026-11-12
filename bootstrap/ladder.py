#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""The bootstrap ladder (docs/BOOTSTRAP-LADDER.md) as code: bootstrap tries each rung in order and records why each failed.

  rung 1  connect        a Wrangler OAuth session ("Allow" on Cloudflare's own screen); nothing is minted or pasted
  rung 2  temporary      a temporary account; created by apps/launcher, not by this script (recorded as skipped)
  rung 3  alarm-tick     a Durable Object alarm instead of a cron trigger, when the account refuses cron triggers
  rung 4  scoped-token   CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID supplied by the owner (last resort)

Rungs 1, 2 and 4 choose HOW to reach the account; rung 3 chooses how the deployed Worker ticks. A bootstrap that ends
without a route, or with a rung that has no recorded reason, is a defect, so `run_ladder` returns one attempt per rung.
Everything takes its commands through an injected `run(cmd, env=None, timeout=None)`; no secret value is read into a
result, a log or a file (only whether a variable is set). Stdlib only.
"""
from __future__ import annotations

import re

ACCOUNT_ID = re.compile(r"\b[0-9a-f]{32}\b")
CRON_REFUSAL = re.compile(r"10072|cron triggers?|cron_trigger|triggers? (?:are )?not (?:allowed|supported)|maximum number of cron", re.I)


def parse_whoami(text: str) -> dict:
    """What `wrangler whoami` printed: whether a session exists, how, and which account ids it can reach."""
    low = text.lower()
    if "not authenticated" in low or "not logged in" in low or "run `wrangler login`" in low:
        return {"logged_in": False, "method": None, "accounts": []}
    method = "oauth" if "oauth" in low else "api_token" if "api token" in low else "unknown"
    logged = "logged in" in low or bool(ACCOUNT_ID.search(low))
    return {"logged_in": logged, "method": method if logged else None, "accounts": sorted(set(ACCOUNT_ID.findall(low)))}


def _attempt(rung: str, status: str, reason: str, **extra) -> dict:
    return {"rung": rung, "status": status, "reason": reason, **extra}


def rung_connect(run, env: dict, wrangler: list[str], interactive: bool = False) -> dict:
    """Rung 1: a Wrangler OAuth session. With no session and `interactive`, start `wrangler login` (the person clicks Allow)."""
    if env.get("CLOUDFLARE_API_TOKEN"):
        return _attempt("connect", "skipped", "a token is already set, so the connect step is not needed (rung scoped-token applies)")

    def who():
        r = run(wrangler + ["whoami"], env=env, timeout=90)
        return parse_whoami((r.stdout or "") + (r.stderr or ""))

    info = who()
    if not info["logged_in"] and interactive:
        run(wrangler + ["login"], env=env, timeout=300)  # opens Cloudflare's own page; the person clicks Allow once
        info = who()
    if not info["logged_in"]:
        return _attempt("connect", "needs_click", "no Cloudflare session; run `npx wrangler login` and click Allow once (nothing is created or pasted)")
    accounts = info["accounts"]
    want = env.get("CLOUDFLARE_ACCOUNT_ID")
    if want and want in accounts:
        accounts = [want]
    if len(accounts) != 1:
        n = len(accounts)
        return _attempt("connect", "failed", f"signed in, but {n} accounts are reachable; set CLOUDFLARE_ACCOUNT_ID to one of them" if n else "signed in, but no account id was reported")
    return _attempt("connect", "ready", "Wrangler OAuth session found", env={"CLOUDFLARE_ACCOUNT_ID": accounts[0]})


def rung_temporary() -> dict:
    return _attempt("temporary", "skipped", "temporary accounts are created by apps/launcher (it deploys with the alarm tick); this script cannot sign a person in")


def rung_token(env: dict) -> dict:
    missing = [n for n in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID") if not env.get(n)]
    if missing:
        return _attempt("scoped-token", "unavailable", "not set: " + ", ".join(missing))
    return _attempt("scoped-token", "ready", "scoped token and account id are set", env={})


def run_ladder(run, env: dict, wrangler_available: bool = True, wrangler: list[str] | None = None, interactive: bool = False) -> dict:
    """Try the rungs in order. Returns {route, env, tick_mode, attempts}; env holds only non-secret extras (the account id)."""
    wr = wrangler or ["npx", "wrangler"]
    attempts: list[dict] = []
    route, extra = None, {}
    steps = [
        ("connect", lambda: rung_connect(run, env, wr, interactive) if wrangler_available else _attempt("connect", "unavailable", "wrangler is not installed here")),
        ("temporary", rung_temporary),
        ("scoped-token", lambda: rung_token(env)),
    ]
    for name, fn in steps:
        if route:
            attempts.append(_attempt(name, "not_tried", f"route '{route}' already works"))
            continue
        a = fn()
        attempts.append(a)
        if a["status"] == "ready":
            route, extra = name, a.get("env", {})
    return {"route": route, "env": extra, "tick_mode": "cron", "attempts": attempts}


def render_wrangler(text: str, tick_mode: str) -> str:
    """Rung 3: in alarm mode drop the cron trigger and set TICK_MODE; the Heartbeat Durable Object then ticks the Worker."""
    if tick_mode not in ("cron", "alarm"):
        raise ValueError("tick_mode must be 'cron' or 'alarm'")
    out = re.sub(r'"TICK_MODE":\s*"[^"]*"', f'"TICK_MODE": "{tick_mode}"', text)
    if tick_mode == "alarm":
        out = re.sub(r'^[ \t]*"triggers":\s*\{[^}]*\},?[ \t]*\n', "", out, flags=re.M)
    return out


def is_cron_refusal(message: str) -> bool:
    """Did a deploy fail because the account refuses cron triggers (a temporary account, or the Free-plan limit)?"""
    return bool(CRON_REFUSAL.search(message or ""))


def gate_card(result: dict) -> dict | None:
    """The one owner card when no rung worked: the cheapest action, with every rung's recorded reason."""
    if result["route"]:
        return None
    first = next((a for a in result["attempts"] if a["status"] == "needs_click"), None)
    why = "; ".join(f"{a['rung']}: {a['status']} ({a['reason']})" for a in result["attempts"])
    return {
        "id": "GATE-LADDER",
        "what": first["reason"] if first else "Connect a Cloudflare account (see rungs below)",
        "why_gated": "signing in to Cloudflare is the person's own act; " + why,
        "default_in_effect": "dry run; every other stage continues",
        "prepared_by_fleet": "bootstrap/ladder.py tried every rung; reasons are in org/ladder.json",
        "closing_probe": "org/ladder.json route is not null",
    }
