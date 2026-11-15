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
DO_RECONCILE = re.compile(r"provisioned_class_missing_from_config|Durable Object exports reconciliation", re.I)
TOKEN_ENV = ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID")
CRON_REFUSAL = re.compile(r"10072|cron triggers?|cron_trigger|triggers? (?:are )?not (?:allowed|supported)|maximum number of cron", re.I)


def parse_whoami(text: str) -> dict:
    """What `wrangler whoami` printed: whether a session exists, how, and which account ids it can reach."""
    low = text.lower()
    if "not authenticated" in low or "not logged in" in low or "run `wrangler login`" in low:
        return {"logged_in": False, "method": None, "accounts": []}
    method = "oauth" if "oauth" in low else "api_token" if "api token" in low else "unknown"
    logged = "logged in" in low or bool(ACCOUNT_ID.search(low))
    return {"logged_in": logged, "method": method if logged else None, "accounts": sorted(set(ACCOUNT_ID.findall(low)))}


def target_account(runtime: dict | None, env: dict) -> str | None:
    """The one Cloudflare account this run may deploy into: the org config's runtime.account_id, else ULTRASTABLE_TARGET_ACCOUNT_ID.
    None means no target is configured (the guard is then recorded as not enforced). A malformed value is returned as-is so it matches
    nothing and every account is refused, never silently ignored."""
    v = ((runtime or {}).get("account_id") or env.get("ULTRASTABLE_TARGET_ACCOUNT_ID") or "").strip().lower()
    return v or None


def _attempt(rung: str, status: str, reason: str, **extra) -> dict:
    return {"rung": rung, "status": status, "reason": reason, **extra}


def rung_connect(run, env: dict, wrangler: list[str], interactive: bool = False, target: str | None = None) -> dict:
    """Rung 1: a Wrangler OAuth session. With no session and `interactive`, start `wrangler login` (the person clicks Allow)."""
    set_aside: list[str] = []
    if env.get("CLOUDFLARE_API_TOKEN"):
        named = (env.get("CLOUDFLARE_ACCOUNT_ID") or "").strip().lower()
        if not (target and named and named != target):
            return _attempt("connect", "skipped", "a token is already set, so the connect step is not needed (rung scoped-token applies)")
        # Issue #181: the token names another account, so it can never be used for the target. It must not hide a Wrangler
        # session that does reach the target: ask Wrangler again without the token and its account id (both are set aside,
        # only for this run's commands; nothing is read from or written to the token).
        set_aside = [n for n in TOKEN_ENV if n in env]
        env = {k: v for k, v in env.items() if k not in TOKEN_ENV}
        interactive = False  # never open a sign-in page as a side effect of a wrong token

    def who():
        r = run(wrangler + ["whoami"], env=env, timeout=90)
        return parse_whoami((r.stdout or "") + (r.stderr or ""))

    info = who()
    if not info["logged_in"] and interactive:
        run(wrangler + ["login"], env=env, timeout=300)  # opens Cloudflare's own page; the person clicks Allow once
        info = who()
    if not info["logged_in"] and set_aside:
        return _attempt("connect", "skipped", f"the token names another account than the target {target} and no Wrangler session exists to use instead", code="account_mismatch")
    if not info["logged_in"]:
        return _attempt("connect", "needs_click", "no Cloudflare session; run `npx wrangler login` and click Allow once (nothing is created or pasted)")
    accounts = info["accounts"]
    if target:  # account guard (issue #167): the session must reach the intended account; any other is refused, never used
        if target not in accounts:
            return _attempt("connect", "failed", f"refused: the Wrangler session reaches {len(accounts)} account(s) and none is the configured target account {target}; nothing was deployed", code="account_mismatch")
        accounts = [target]
    want = env.get("CLOUDFLARE_ACCOUNT_ID")
    if want and want in accounts:
        accounts = [want]
    elif want and accounts:
        return _attempt("connect", "failed", f"refused: CLOUDFLARE_ACCOUNT_ID {want} is not reachable by this session")
    if len(accounts) != 1:
        n = len(accounts)
        return _attempt("connect", "failed", f"signed in, but {n} accounts are reachable; set CLOUDFLARE_ACCOUNT_ID to one of them" if n else "signed in, but no account id was reported")
    if set_aside:
        return _attempt("connect", "ready", "Wrangler OAuth session reaches the target account; the token set for another account was set aside for this run",
                        env={"CLOUDFLARE_ACCOUNT_ID": accounts[0]}, unset=["CLOUDFLARE_API_TOKEN"])
    return _attempt("connect", "ready", "Wrangler OAuth session found", env={"CLOUDFLARE_ACCOUNT_ID": accounts[0]})


def rung_temporary() -> dict:
    return _attempt("temporary", "skipped", "temporary accounts are created by apps/launcher (it deploys with the alarm tick); this script cannot sign a person in")


def rung_token(env: dict, target: str | None = None, run=None, wrangler: list[str] | None = None) -> dict:
    """Rung 4. With a target the account id is never taken on trust: another id is refused, a missing id is filled with the target
    (it is not a secret), and when `run` is given the token is asked which accounts it reaches before anything is provisioned."""
    have = (env.get("CLOUDFLARE_ACCOUNT_ID") or "").strip().lower()
    if target and have and have != target:
        return _attempt("scoped-token", "failed", f"refused: CLOUDFLARE_ACCOUNT_ID {have} is not the configured target account {target}", code="account_mismatch")
    extra = {"CLOUDFLARE_ACCOUNT_ID": target} if target and not have else {}
    missing = [n for n in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID") if not env.get(n) and n not in extra]
    if missing:
        return _attempt("scoped-token", "unavailable", "not set: " + ", ".join(missing))
    if target and run:  # issue #181: a token for a different account is detected here, not by a failed deploy half way through
        r = run((wrangler or ["npx", "wrangler"]) + ["whoami"], env={**env, **extra}, timeout=90)
        reach = parse_whoami((r.stdout or "") + (r.stderr or ""))["accounts"]
        if reach and target not in reach:
            return _attempt("scoped-token", "failed", f"refused: the token reaches {len(reach)} account(s) and none is the configured target account {target}; nothing was deployed", code="account_mismatch")
    why = "scoped token is set; the account id is pinned to the configured target account" if extra else "scoped token and account id are set"
    return _attempt("scoped-token", "ready", why, env=extra)


def run_ladder(run, env: dict, wrangler_available: bool = True, wrangler: list[str] | None = None, interactive: bool = False, target: str | None = None) -> dict:
    """Try the rungs in order. Returns {route, env, tick_mode, attempts}; env holds only non-secret extras (the account id)."""
    wr = wrangler or ["npx", "wrangler"]
    attempts: list[dict] = []
    route, extra, unset = None, {}, []
    steps = [
        ("connect", lambda: rung_connect(run, env, wr, interactive, target) if wrangler_available else _attempt("connect", "unavailable", "wrangler is not installed here")),
        ("temporary", rung_temporary),
        ("scoped-token", lambda: rung_token(env, target, run if wrangler_available else None, wr)),
    ]
    for name, fn in steps:
        if route:
            attempts.append(_attempt(name, "not_tried", f"route '{route}' already works"))
            continue
        a = fn()
        attempts.append(a)
        if a["status"] == "ready":
            route, extra, unset = name, a.get("env", {}), a.get("unset", [])
    mismatch = [a["rung"] for a in attempts if a.get("code") == "account_mismatch"]
    return {"route": route, "env": extra, "unset": unset, "tick_mode": "cron",
            "account_guard": {"target": target, "enforced": bool(target), "mismatch": mismatch}, "attempts": attempts}


def command_env(base: dict, result: dict) -> dict:
    """The environment every provisioning command runs with: the ladder's non-secret extras applied, and any variable the chosen
    route set aside removed, so a token for another account can never reach a deploy."""
    drop = set(result.get("unset") or [])
    return {**{k: v for k, v in base.items() if k not in drop}, **(result.get("env") or {})}


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


def is_heartbeat_reconcile_failure(message: str) -> bool:
    """Did a redeploy fail on the Durable Object class reconcile (provisioned_class_missing_from_config, live trial 2026-11-12)?"""
    return bool(DO_RECONCILE.search(message or ""))


def cron_period_minutes(cron: str | None) -> int:
    """Minutes between ticks for the simple crons the template uses (`*/N * * * *`, `M */H * * *`); 60 when unknown."""
    parts = (cron or "").split()
    if len(parts) == 5:
        m = re.fullmatch(r"\*/(\d+)", parts[0])
        if m and int(m.group(1)) > 0:
            return int(m.group(1))
        h = re.fullmatch(r"\*/(\d+)", parts[1])
        if h and int(h.group(1)) > 0:
            return int(h.group(1)) * 60
    return 60


def cron_silent(health: dict | None, deployed_at: str, now, cron: str | None, grace_periods: int = 2, floor_minutes: int = 15) -> bool:
    """True when a cron-mode Worker answers /health but no tick has run `grace_periods` periods (floor `floor_minutes`) after the deploy:
    the cron registered and never fired (live trial 2026-11-12), so the caller falls back to the Durable Object alarm."""
    import datetime as dt
    if not isinstance(health, dict) or not health.get("ok") or health.get("last_tick"):
        return False
    try:
        t0 = dt.datetime.fromisoformat(deployed_at)
    except (TypeError, ValueError):
        return False
    if t0.tzinfo is None:
        t0 = t0.replace(tzinfo=dt.timezone.utc)
    return now >= t0 + dt.timedelta(minutes=max(cron_period_minutes(cron) * grace_periods, floor_minutes))


def gate_card(result: dict) -> dict | None:
    """The one owner card when no rung worked: the cheapest action, with every rung's recorded reason."""
    if result["route"]:
        return None
    first = next((a for a in result["attempts"] if a["status"] == "needs_click"), None)
    why = "; ".join(f"{a['rung']}: {a['status']} ({a['reason']})" for a in result["attempts"])
    guard = result.get("account_guard") or {}
    wrong = f"Connect the configured target Cloudflare account {guard.get('target')}: every credential found here is for a different account, and none was used" if guard.get("mismatch") else None
    return {
        "id": "GATE-LADDER",
        "what": wrong or (first["reason"] if first else "Connect a Cloudflare account (see rungs below)"),
        "why_gated": "signing in to Cloudflare is the person's own act; " + why,
        "default_in_effect": "dry run; every other stage continues",
        "prepared_by_fleet": "bootstrap/ladder.py tried every rung; reasons are in org/ladder.json",
        "closing_probe": "org/ladder.json route is not null",
    }
