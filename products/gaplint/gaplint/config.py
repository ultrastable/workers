# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Default configuration. A repository overrides any key in gaplint.json at its root.

Nested objects merge key by key, except `required`, which a repository replaces whole."""
import copy
import json
from pathlib import Path

DEFAULTS = {
    "rules": ["GL001", "GL002", "GL003", "GL004", "GL006", "GL007"],
    "gap_entries": {
        "files": ["docs/BOOTSTRAP-GAPS.md", "BOOTSTRAP-GAPS.md"],
        "heading": r"^##\s+(?:Owner card:\s+)?BG-\d+",
        "skip_closed": True,
        "required": {
            "symptom": ["symptom"],
            "fix in code": ["fix in code", "fix applied", "fix:", "seed fix"],
            "default in effect": ["default in effect", "default:"],
            "closing probe": ["closing probe", "probe"],
        },
    },
    "owner_cards": {
        "files": ["**/OWNER-CARD*.md", "**/owner-card*.md"],
        "required": {"default in effect": ["default"], "closing probe": ["probe"]},
    },
    "agent_rules": {
        "files": ["agents/AGENTS.md", "AGENTS.md"],
        "required": {
            "code is all that matters": r"code is all that matters",
            "not in code does not exist": r"not in code,? it (?:does not|doesn't) exist",
            "never swallow an error": r"never swallow an error",
        },
    },
    "person_as_actor": {
        "files": ["docs/handoff/*.md"],
        "patterns": [r"\bneeds you to\b", r"\bif you want\b", r"\blet me know if\b", r"\btell me to\b", r"\byou should\b", r"\byou'll need to\b"],
    },
    "public_safe": {"files": [], "banned": []},
    "memory_file": {"path": "docs/PROJECT-MEMORY.md"},
    "tagline": {"doctrine": "", "files": [], "text": "Ultrastable is the foundation for any autonomous system", "pattern": r"foundation\s+for\s+any\s+autonomous\s+system"},
}


def _merge(base, over):
    for k, v in over.items():
        if k != "required" and isinstance(v, dict) and isinstance(base.get(k), dict):
            _merge(base[k], v)
        else:
            base[k] = v
    return base


def load(root: Path, path=None):
    cfg = copy.deepcopy(DEFAULTS)
    p = Path(path) if path else root / "gaplint.json"
    if p.exists():
        _merge(cfg, json.loads(p.read_text(encoding="utf-8")))
    return cfg
