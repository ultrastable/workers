#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Close the loops on the repository's own work tracker. Nothing here waits for a person to remember.

Rules (each is enforced by code, and each outcome is written back to the tracker as a record):

  L1  Every open issue carries an evaluable `Closing probe:` line, or has a linked pull request (the default probe:
      the pull request merges and closes it). Otherwise it is labelled `open-loop` once it is older than the grace period.
  L2  A probe that passes closes the issue with the evidence in a comment. Probes: `pr_merged:#N`, `issue_closed:#N`,
      `file_exists:<path>` (checked in the checkout).
  L3  An epic (title starts `EPIC:`) is a checklist whose every unchecked item without an issue link gets a child issue
      filed here, and the item is rewritten to point at it. A checked or closed child ticks its box. An epic with every
      box ticked closes itself.
  L4  An issue whose linked pull request has had no update for the stale period is labelled `stalled`.
  L5  The run writes a summary of open loops by rule; the exit status is 1 while any open loop remains past the grace period.

  python tools/loop_closer.py --repo OWNER/REPO [--apply] [--grace-hours 24] [--stale-days 7]

Dry run by default. Needs the `gh` CLI and a token that can write issues. Stdlib only.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path

PROBE = re.compile(r"^\s*closing probe:\s*(\w+):(.+?)\s*$", re.I | re.M)
CHECK = re.compile(r"^(\s*[-*]\s+)\[( |x|X)\]\s+(.*)$", re.M)
LINK = re.compile(r"#(\d+)")
LABEL_OPEN, LABEL_STALLED = "open-loop", "stalled"


class Gh:
    """Thin wrapper over the gh CLI. Tests substitute a fake with the same methods."""

    def __init__(self, repo: str):
        self.repo = repo

    def _run(self, *args, data: str | None = None) -> str:
        out = subprocess.run(["gh", *args], input=data, capture_output=True, text=True, check=True)
        return out.stdout

    def issues(self) -> list[dict]:
        j = self._run("issue", "list", "-R", self.repo, "--state", "all", "--limit", "500",
                      "--json", "number,title,body,state,labels,createdAt,updatedAt")
        return json.loads(j)

    def prs(self) -> list[dict]:
        j = self._run("pr", "list", "-R", self.repo, "--state", "all", "--limit", "500",
                      "--json", "number,title,body,state,isDraft,updatedAt,mergedAt")
        return json.loads(j)

    def latest_ci(self, branch: str = "main", workflow: str = "ci") -> str | None:
        """Conclusion of the most recent COMPLETED run of the workflow on the branch (success, failure, ...), or None.
        None also when the token cannot read Actions (the loops workflow has no `actions: read`): ci_green probes then stay
        unevaluated instead of crashing the whole closer before it touches a single issue."""
        try:
            j = self._run("run", "list", "-R", self.repo, "-w", workflow, "-b", branch, "--limit", "10", "--json", "status,conclusion")
        except subprocess.CalledProcessError as e:
            print(f"latest_ci unavailable ({(e.stderr or '').strip()[:200]}); ci_green probes are skipped this run", file=sys.stderr)
            return None
        done = [r for r in json.loads(j) if r.get("status") == "completed"]
        return done[0]["conclusion"] if done else None

    def release_tags(self) -> set[str] | None:
        """Tags of published releases, or None when the list cannot be read."""
        try:
            return {r["tagName"] for r in json.loads(self._run("release", "list", "-R", self.repo, "--limit", "100", "--json", "tagName"))}
        except subprocess.CalledProcessError:
            return None

    def comment(self, n: int, text: str): self._run("issue", "comment", str(n), "-R", self.repo, "--body", text)
    def close(self, n: int, text: str): self._run("issue", "close", str(n), "-R", self.repo, "--reason", "completed", "--comment", text)
    def label(self, n: int, name: str): self._run("issue", "edit", str(n), "-R", self.repo, "--add-label", name)
    def unlabel(self, n: int, name: str): self._run("issue", "edit", str(n), "-R", self.repo, "--remove-label", name)
    def edit_body(self, n: int, body: str): self._run("issue", "edit", str(n), "-R", self.repo, "--body-file", "-", data=body)

    def create(self, title: str, body: str) -> int:
        url = self._run("issue", "create", "-R", self.repo, "--title", title, "--body", body).strip()
        return int(url.rsplit("/", 1)[1])

    def ensure_label(self, name: str, color: str):
        subprocess.run(["gh", "label", "create", name, "-R", self.repo, "-c", color], capture_output=True, text=True)


def _parse(ts: str) -> dt.datetime:
    return dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))


def eval_probe(kind: str, arg: str, issues: dict[int, dict], prs: dict[int, dict], root: Path) -> tuple[bool | None, str]:
    """True = passes, False = fails, None = not evaluable."""
    arg = arg.strip().strip("`")
    k = kind.lower()
    if k in ("pr_merged", "issue_closed"):
        m = LINK.search(arg)
        if not m:
            return None, f"{kind}: no #number in '{arg}'"
        n = int(m.group(1))
        if k == "pr_merged":
            pr = prs.get(n)
            return (bool(pr and pr.get("mergedAt")), f"pull request #{n} merged" if pr and pr.get("mergedAt") else f"pull request #{n} not merged")
        iss = issues.get(n)
        return (bool(iss and iss["state"].upper() == "CLOSED"), f"issue #{n} closed" if iss and iss["state"].upper() == "CLOSED" else f"issue #{n} still open")
    if k == "ci_green":
        return None, "ci_green is evaluated by the runner with the tracker client"
    if k == "file_exists":
        p = (root / arg).resolve()
        if root.resolve() not in p.parents and p != root.resolve():
            return None, "path escapes the checkout"
        return p.exists(), f"{arg} {'exists' if p.exists() else 'missing'}"
    return None, f"unknown probe kind '{kind}'"


def linked_prs(n: int, prs: dict[int, dict]) -> list[dict]:
    pat = re.compile(rf"(?<![\w/])#{n}\b")
    return [p for p in prs.values() if pat.search(p.get("body") or "")]


def run(gh, root: Path, apply: bool, now: dt.datetime, grace_h: float, stale_d: float) -> dict:
    issues = {i["number"]: i for i in gh.issues()}
    prs = {p["number"]: p for p in gh.prs()}
    result = {"closed": [], "open_loop": [], "stalled": [], "children": [], "epics_closed": [], "ticked": [], "incidents": []}
    ci = gh.latest_ci("main") if hasattr(gh, "latest_ci") else None
    tags = gh.release_tags() if hasattr(gh, "release_tags") else None
    names = lambda i: {l["name"] for l in i.get("labels", [])}  # noqa: E731

    for n, i in sorted(issues.items()):
        if i["state"].upper() != "OPEN":
            continue
        body = i.get("body") or ""
        age_h = (now - _parse(i["createdAt"])).total_seconds() / 3600
        is_epic = i["title"].upper().startswith("EPIC")

        if is_epic:
            new_body, changed = body, False
            for m in list(CHECK.finditer(body)):
                lead, box, text = m.group(1), m.group(2), m.group(3)
                link = LINK.search(text)
                if link:
                    child = issues.get(int(link.group(1)))
                    if box == " " and child and child["state"].upper() == "CLOSED":
                        new_body = new_body.replace(m.group(0), f"{lead}[x] {text}", 1); changed = True; result["ticked"].append((n, int(link.group(1))))
                    continue
                if box != " ":
                    continue
                title = re.sub(r"`", "", text.split(":")[0])[:90].strip()
                child_body = (f"Part of #{n}.\n\n{text}\n\nClosing probe: the linked pull request merges and closes this issue. "
                              f"A draft pull request is opened with this issue (default probe).")
                if apply:
                    cn = gh.create(title, child_body)
                    new_body = new_body.replace(m.group(0), f"{lead}[ ] #{cn} {text}", 1); changed = True
                else:
                    cn = -1
                result["children"].append((n, cn, title))
            if changed and apply:
                gh.edit_body(n, new_body)
            remaining = [m for m in CHECK.finditer(new_body) if m.group(2) == " "]
            if CHECK.search(new_body) and not remaining:
                result["epics_closed"].append(n)
                if apply:
                    gh.close(n, "Every checklist item is ticked and its issue closed. Closed by tools/loop_closer.py.")
            continue

        probe = PROBE.search(body)
        prs_for = linked_prs(n, prs)
        if probe:
            if probe.group(1).lower() == "ci_green":
                ok, ev = (ci == "success"), f"latest ci run on main: {ci}"
            elif probe.group(1).lower() == "release_exists":
                tag = probe.group(2).strip().strip("`")
                ok, ev = (tags is not None and tag in tags), f"release {tag} {'published' if tags is not None and tag in tags else 'not found'}"
            else:
                ok, ev = eval_probe(probe.group(1), probe.group(2), issues, prs, root)
            if ok:
                result["closed"].append((n, ev))
                if apply:
                    gh.close(n, f"Closing probe passed: {ev}. Closed by tools/loop_closer.py.")
                continue
        if not probe and not prs_for and age_h > grace_h:
            result["open_loop"].append((n, "no closing probe and no linked pull request"))
            if apply and LABEL_OPEN not in names(i):
                gh.label(n, LABEL_OPEN)
                gh.comment(n, "OPEN LOOP: this issue has neither a `Closing probe:` line nor a linked pull request. "
                              "Open a draft pull request that says `Refs #%d`, or add a `Closing probe:` line (pr_merged, issue_closed or file_exists)." % n)
        elif LABEL_OPEN in names(i) and (probe or prs_for) and apply:
            gh.unlabel(n, LABEL_OPEN)
        live = [p for p in prs_for if p["state"].upper() == "OPEN"]
        if live and all((now - _parse(p["updatedAt"])).days >= stale_d for p in live):
            result["stalled"].append((n, f"pull request #{live[0]['number']} idle {stale_d:g}+ days"))
            if apply and LABEL_STALLED not in names(i):
                gh.label(n, LABEL_STALLED)
    incident_title = "INCIDENT: ci is red on main"
    open_incident = any(i["state"].upper() == "OPEN" and i["title"].startswith(incident_title) for i in issues.values())
    if ci not in (None, "success", "cancelled", "skipped") and not open_incident:
        result["incidents"].append(ci)
        if apply:
            gh.create(incident_title, f"The latest completed ci run on main concluded: {ci}. Fix main before anything else merges." + chr(10) + chr(10) + "Closing probe: ci_green:main")
    return result


def summary(r: dict) -> str:
    lines = [f"closed by probe: {len(r['closed'])}", f"open loops: {len(r['open_loop'])}", f"stalled: {len(r['stalled'])}",
             f"child issues filed from epics: {len(r['children'])}", f"epic boxes ticked: {len(r['ticked'])}", f"epics closed: {len(r['epics_closed'])}", f"incidents opened: {len(r['incidents'])}"]
    for kind in ("open_loop", "stalled"):
        for n, why in r[kind]:
            lines.append(f"  #{n} [{kind}] {why}")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo", required=True)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--root", default=".")
    ap.add_argument("--grace-hours", type=float, default=24)
    ap.add_argument("--stale-days", type=float, default=7)
    a = ap.parse_args(argv)
    gh = Gh(a.repo)
    if a.apply:
        gh.ensure_label(LABEL_OPEN, "B60205"); gh.ensure_label(LABEL_STALLED, "FBCA04")
    r = run(gh, Path(a.root), a.apply, dt.datetime.now(dt.timezone.utc), a.grace_hours, a.stale_days)
    print(summary(r))
    return 1 if r["open_loop"] else 0


if __name__ == "__main__":
    sys.exit(main())
