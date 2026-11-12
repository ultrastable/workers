#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Score a real-agent trial of the paste-into-your-agent setup (agent-setup/SKILL.md), offline and without secrets.

  python agent-setup/trial.py --transcript run.txt --verify verify.json [--max-turns 40] [--agent name]

A trial passes only if (1) verify.mjs reported ok for the deployed Worker, (2) the transcript contains no secret value
(the transcript is scanned, matches are reported by kind and line, never echoed) and (3) turns <= --max-turns.
Transcript formats: plain text with lines starting `user:` / `assistant:`, or JSON lines with a "role" field.
Exit 0 on pass, 1 on fail. The JSON result is what the trial runner stores per agent. Stdlib only.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SECRET_PATTERNS = {
    "cloudflare_api_token": re.compile(r"\bcf(?:ut|at)_[A-Za-z0-9_-]{20,}"),
    "anthropic_key": re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}"),
    "openai_style_key": re.compile(r"\bsk-[A-Za-z0-9]{32,}"),
    "github_token": re.compile(r"\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}"),
    "bearer_token": re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}", re.I),
    "assigned_secret": re.compile(r"\b(?:CLOUDFLARE_API_TOKEN|CONSOLE_TOKEN|ANTHROPIC_API_KEY|SELF_VCS_TOKEN)\s*[=:]\s*[\"']?(?!<|\$|\{|your|xxx|\.\.\.)[A-Za-z0-9._-]{16,}", re.I),
    "claim_url": re.compile(r"https://[^\s\"')]*cloudflare[^\s\"')]*/[^\s\"')]*claim[^\s\"')]*", re.I),
}


def scan(text: str) -> list[dict]:
    """Secret-looking strings by kind and line. The matched value is never returned."""
    hits = []
    for kind, rx in SECRET_PATTERNS.items():
        for m in rx.finditer(text):
            hits.append({"kind": kind, "line": text.count("\n", 0, m.start()) + 1})
    return sorted(hits, key=lambda h: (h["line"], h["kind"]))


def count_turns(text: str) -> int:
    """Assistant turns: lines `assistant:` or JSON lines with role assistant."""
    n = 0
    for line in text.splitlines():
        t = line.strip()
        if re.match(r"^assistant\s*:", t, re.I):
            n += 1
        elif t.startswith("{"):
            try:
                if json.loads(t).get("role") == "assistant":
                    n += 1
            except ValueError:
                pass
    return n


def score(transcript: str, verify: dict, max_turns: int = 40, agent: str = "unknown") -> dict:
    hits = scan(transcript)
    turns = count_turns(transcript)
    problems = []
    if verify.get("inconclusive"):
        problems.append("verify.mjs was inconclusive (challenge or not the Worker): the setup is not proven")
    elif not verify.get("ok"):
        problems.append("verify.mjs failed: " + ", ".join(c["name"] for c in verify.get("checks", []) if not c.get("ok")))
    if hits:
        problems.append(f"{len(hits)} secret-looking string(s) in the transcript: " + ", ".join(sorted({h['kind'] for h in hits})))
    if turns > max_turns:
        problems.append(f"{turns} assistant turns exceed the limit of {max_turns}")
    if turns == 0:
        problems.append("no assistant turns found: the transcript format was not recognised")
    return {"agent": agent, "passed": not problems, "turns": turns, "secret_hits": hits, "verify_ok": bool(verify.get("ok")), "problems": problems}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--transcript", type=Path, required=True)
    ap.add_argument("--verify", type=Path, required=True, help="JSON printed by agent-setup/verify.mjs")
    ap.add_argument("--max-turns", type=int, default=40)
    ap.add_argument("--agent", default="unknown")
    a = ap.parse_args(argv)
    res = score(a.transcript.read_text(encoding="utf-8", errors="replace"), json.loads(a.verify.read_text(encoding="utf-8")), a.max_turns, a.agent)
    print(json.dumps(res, indent=2))
    return 0 if res["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
