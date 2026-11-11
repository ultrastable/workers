# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""GitHub connector (CORE-4): work items from issues, pull requests as the execution surface, merge on green.

Every call goes through `transport(method, path, body=None) -> (status, json)` so tests and tenants choose the HTTP layer.
`github_transport(token_env)` is the real one (urllib, token read from the environment by name, never stored).
Policy: the connector never merges a draft, never merges red or pending checks, and never merges a PR it did not open.
"""
from __future__ import annotations
import json, os, re, urllib.request, urllib.error
from typing import Callable, Optional

Transport = Callable[..., tuple]
API = "https://api.github.com"


def github_transport(token_env: str = "GITHUB_TOKEN", api: str = API) -> Transport:
    def call(method: str, path: str, body=None):
        tok = os.environ.get(token_env)
        if not tok:
            raise RuntimeError(f"{token_env} not set")
        req = urllib.request.Request(api + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={"authorization": f"Bearer {tok}", "accept": "application/vnd.github+json",
                                              "content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, {"error": e.read().decode(errors="replace")[:500]}
    return call


def _field(body: str, *names: str) -> Optional[str]:
    for n in names:
        m = re.search(r"\*\*" + re.escape(n) + r":?\*\*:?\s*(.+)", body or "", re.I)
        if m:
            return m.group(1).strip()
    return None


class GitHubConnector:
    def __init__(self, repo: str, transport: Transport, label: str = "agent-ready", bot_login: Optional[str] = None):
        self.repo, self.t, self.label, self.bot = repo, transport, label, bot_login

    def _req(self, method, path, body=None):
        st, data = self.t(method, f"/repos/{self.repo}{path}", body)
        if st >= 400:
            raise RuntimeError(f"github {method} {path}: {st} {data}")
        return data

    # ---- items from issues ------------------------------------------------------------
    def items(self) -> list:
        out = []
        for i in self._req("GET", f"/issues?state=open&labels={self.label}&per_page=100"):
            if "pull_request" in i:
                continue
            body = i.get("body") or ""
            out.append({"id": f"GH-{i['number']}", "title": i["title"], "kind": "work",
                        "done_check": _field(body, "Done check", "Done when") or "verified by a different agent",
                        "closing_probe": _field(body, "Closing probe", "Probe"),
                        "owner_role": "staff", "priority": 50, "status": "ready", "source": i["html_url"]})
        return out

    def sync(self, engine) -> int:
        """Add every open agent-ready issue to the engine's queue once; returns how many were new."""
        n = 0
        for it in self.items():
            if not engine.s.one("SELECT 1 FROM items WHERE id=?", it["id"]):
                engine.add_item(**{k: v for k, v in it.items() if k != "source"})
                n += 1
        return n

    # ---- pull requests as execution -----------------------------------------------------
    def open_pr(self, head: str, title: str, body: str, base: str = "main") -> int:
        return self._req("POST", "/pulls", {"title": title, "head": head, "base": base, "body": body, "draft": True})["number"]

    def checks_state(self, sha: str) -> str:
        runs = self._req("GET", f"/commits/{sha}/check-runs")["check_runs"]
        if not runs or any(r["status"] != "completed" for r in runs):
            return "pending"
        return "green" if all(r["conclusion"] in ("success", "neutral", "skipped") for r in runs) else "red"

    def verify_pr(self, number: int) -> tuple:
        """Reviewer verdict for a PR: (True, why) merged or green, (None, why) checks pending, (False, why) red or blocked."""
        pr = self._req("GET", f"/pulls/{number}")
        if pr.get("merged"):
            return True, "already merged"
        state = self.checks_state(pr["head"]["sha"])
        if state == "pending":
            return None, "checks pending"
        if state == "red":
            return False, "checks red"
        merged, why = self.merge_if_green(number)
        return (True if merged else False), why

    def merge_if_green(self, number: int) -> tuple:
        """Returns (merged, reason). Refuses drafts, red or pending checks, and PRs not opened by the bot login."""
        pr = self._req("GET", f"/pulls/{number}")
        if pr.get("merged"):
            return True, "already merged"
        if pr.get("draft"):
            return False, "draft"
        if self.bot and pr["user"]["login"] != self.bot:
            return False, "not opened by this connector"
        state = self.checks_state(pr["head"]["sha"])
        if state != "green":
            return False, f"checks {state}"
        self._req("PUT", f"/pulls/{number}/merge", {"merge_method": "squash"})
        return True, "merged"

    def close_issue(self, number: int, evidence: str) -> None:
        self._req("POST", f"/issues/{number}/comments", {"body": evidence})
        self._req("PATCH", f"/issues/{number}", {"state": "closed", "state_reason": "completed"})
