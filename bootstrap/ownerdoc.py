# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Owner README generated at bootstrap (issue #23, US-19-R17). Stdlib only.

The text comes from docs/help.md, the same source tools/build_help.mjs turns into the console Help tab, so the README and
the Help view cannot disagree. The README is plain language: no commands, no file names, no secrets.
"""
from __future__ import annotations

import re


def parse_help(md: str) -> list[dict]:
    """Sections of docs/help.md: a `## title` line, then paragraphs. Mirrors parseHelp in tools/build_help.mjs."""
    sections: list[dict] = []
    cur = None
    for line in md.replace("\r\n", "\n").split("\n"):
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            cur = {"title": m.group(1), "lines": []}
            sections.append(cur)
        elif cur is not None:
            cur["lines"].append(line)
    out = []
    for sec in sections:
        paras = [" ".join(p.split()) for p in re.split(r"\n{2,}", "\n".join(sec["lines"]).strip()) if p.strip()]
        if paras:
            out.append({"title": sec["title"], "text": "\n\n".join(paras)})
    return out


def owner_readme(org_name: str, idea_prose: str, outcomes: list, cards: list, help_md: str) -> str:
    lines = [f"# {org_name}", "",
             "This is your organization. A team of software workers runs it for you, on a schedule, "
             "and reports back through a private console page.", ""]
    if idea_prose:
        lines += ["## The idea", "", idea_prose, ""]
    if outcomes:
        lines += ["## What it is working toward", ""] + [f"- {o}" for o in outcomes] + [""]
    lines += ["## What only you can do", ""]
    if cards:
        lines += [f"- {c['what']}. If nothing is done: {c['default_in_effect']}." for c in cards]
    else:
        lines.append("- Nothing right now.")
    lines.append("")
    for sec in parse_help(help_md):
        lines += [f"## {sec['title']}", "", sec["text"], ""]
    return "\n".join(lines).rstrip() + "\n"
