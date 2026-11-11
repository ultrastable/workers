# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Rules. Each rule takes (root, cfg) and yields Finding objects.

Every rule checks something that makes work unfinishable by another agent
cold: a gap with no closing probe, an owner card with no default in effect,
an agent file missing a standing rule, a report that assigns a step to a person.
"""
from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass
from pathlib import Path

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "dist", "build"}


@dataclass(frozen=True)
class Finding:
    rule: str
    path: str
    line: int
    message: str

    def as_dict(self):
        return {"rule": self.rule, "path": self.path, "line": self.line, "message": self.message}


def iter_files(root: Path, patterns, exts=None):
    """Yield files under root whose posix path matches any glob in patterns."""
    for p in sorted(root.rglob("*")):
        if not p.is_file() or any(part in SKIP_DIRS for part in p.relative_to(root).parts):
            continue
        rel = p.relative_to(root).as_posix()
        if exts and p.suffix not in exts:
            continue
        if any(fnmatch.fnmatch(rel, g) for g in patterns):
            yield rel, p


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8", errors="replace")


# GL001: every gap entry names symptom, surfaces tried, a fix in code, a default and a closing probe.
def gap_entries(root, cfg):
    spec = cfg["gap_entries"]
    heading = re.compile(spec["heading"])
    for rel, p in iter_files(root, spec["files"]):
        lines = read(p).splitlines()
        starts = [i for i, ln in enumerate(lines) if heading.match(ln)]
        for n, i in enumerate(starts):
            end = starts[n + 1] if n + 1 < len(starts) else len(lines)
            body = "\n".join(lines[i:end]).lower()
            if spec.get("skip_closed", True) and re.search(r"\bclosed\b", lines[i].lower()):
                continue
            for label, alts in spec["required"].items():
                if not any(a.lower() in body for a in alts):
                    yield Finding("GL001", rel, i + 1, f"gap entry lacks '{label}': {lines[i].strip()[:80]}")


# GL002: an owner card names the default in effect and a closing probe.
def owner_cards(root, cfg):
    spec = cfg["owner_cards"]
    for rel, p in iter_files(root, spec["files"]):
        body = read(p).lower()
        for label, alts in spec["required"].items():
            if not any(a.lower() in body for a in alts):
                yield Finding("GL002", rel, 1, f"owner card lacks '{label}'")


# GL003: agent files carry each required standing rule. `agent_rules` is one spec or a list of specs.
def agent_rules(root, cfg):
    specs = cfg["agent_rules"]
    for spec in specs if isinstance(specs, list) else [specs]:
        for rel, p in iter_files(root, spec["files"]):
            body = read(p).lower()
            for name, pat in spec["required"].items():
                if not re.search(pat, body, re.I | re.S):
                    yield Finding("GL003", rel, 1, f"agent file lacks standing rule '{name}'")


# GL004: reports do not assign a next step to a person.
def person_as_actor(root, cfg):
    spec = cfg["person_as_actor"]
    pats = [re.compile(x, re.I) for x in spec["patterns"]]
    for rel, p in iter_files(root, spec["files"]):
        for i, ln in enumerate(read(p).splitlines(), 1):
            if any(r.search(ln) for r in pats):
                yield Finding("GL004", rel, i, f"hands a step to a person: {ln.strip()[:90]}")


# GL005: nothing in public paths names banned terms.
def public_safe(root, cfg):
    spec = cfg["public_safe"]
    pats = [re.compile(x, re.I) for x in spec["banned"]]
    for rel, p in iter_files(root, spec["files"]):
        for i, ln in enumerate(read(p).splitlines(), 1):
            for r in pats:
                if r.search(ln):
                    yield Finding("GL005", rel, i, f"banned term /{r.pattern}/ in public file")


# GL006: no secret-shaped strings.
SECRET = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{36,}|AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{20,}")


def secrets(root, cfg):
    for rel, p in iter_files(root, ["*"]):
        if p.stat().st_size > 2_000_000:
            continue
        for i, ln in enumerate(read(p).splitlines(), 1):
            if SECRET.search(ln):
                yield Finding("GL006", rel, i, "secret-shaped string")


# GL007: the memory file exists and says when it was last updated.
def memory_file(root, cfg):
    spec = cfg["memory_file"]
    p = root / spec["path"]
    if not p.exists():
        yield Finding("GL007", spec["path"], 1, "memory file missing")
        return
    if not re.search(r"last updated:\s*\d{4}-\d{2}-\d{2}", read(p), re.I):
        yield Finding("GL007", spec["path"], 1, "memory file has no 'Last updated: YYYY-MM-DD' line")


# GL008: positioning. Public copy and agent files carry the tagline "Ultrastable is the foundation for any autonomous system".
def _doctrine(root, spec):
    """Spec values from a doctrine file when `doctrine` is set (the file is the source of truth)."""
    import json
    if spec.get("doctrine") and (root / spec["doctrine"]).exists():
        d = json.loads(read(root / spec["doctrine"]))
        inj = d["inject"]
        return {"pattern": d["pattern"], "text": d["tagline"], "files": inj["md_files"] + inj["check_only"], "doctrine": d}
    return spec


def tagline(root, cfg):
    spec = _doctrine(root, cfg["tagline"])
    pat = re.compile(spec["pattern"], re.I | re.S)
    for rel, p in iter_files(root, spec["files"]):
        if not pat.search(read(p)):
            yield Finding("GL008", rel, 1, "positioning line missing: " + spec["text"])


# GL009: code is the only memory. The canonical memory file exists, agent files state the rule, nothing relies on external memory.
def memory_in_code(root, cfg):
    spec = cfg["tagline"]
    if not (spec.get("doctrine") and (root / spec["doctrine"]).exists()):
        return
    import json
    m = json.loads(read(root / spec["doctrine"]))["memory"]
    if not (root / m["canonical"]).exists():
        yield Finding("GL009", m["canonical"], 1, "canonical memory file missing")
    for rel in m["required_in"]:
        p = root / rel
        if p.exists() and not re.search(m["required_pattern"], read(p), re.I):
            yield Finding("GL009", rel, 1, "agent file lacks the rule '" + m["required_pattern"] + "'")
    pats = [re.compile(x, re.I) for x in m["banned_patterns"]]
    for rel, p in iter_files(root, m["scan"]):
        for i, ln in enumerate(read(p).splitlines(), 1):
            if any(r.search(ln) for r in pats):
                yield Finding("GL009", rel, i, "relies on external memory: " + ln.strip()[:80])


RULES = {
    "GL001": gap_entries,
    "GL002": owner_cards,
    "GL003": agent_rules,
    "GL004": person_as_actor,
    "GL005": public_safe,
    "GL006": secrets,
    "GL007": memory_file,
    "GL008": tagline,
    "GL009": memory_in_code,
}
