# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
from __future__ import annotations
import copy, json, os
from importlib import resources

DEFAULT_CONFIG = {
    "org_name": "My Organization",
    "plus_share": 0.2,
    "max_wip_per_role": 3,
    "slots_per_tick": 6,
    "claim_ttl_minutes": 30,
    "max_attempts": 3,
    "amend_after_failures": 3,
    "audit_after_ticks": 2,
    "tick_minutes": 10,
    "max_auto_rung": "autonomous",  # promotions above this need an owner gate card
    "agents": {
        "doer": {"kind": "simulated", "seed": 7, "fail_rate": 0.12, "hidden_rate": 0.04},
        "reviewer": {"kind": "simulated", "seed": 99, "fail_rate": 0.0, "hidden_rate": 0.0, "catch_rate": 0.9},
    },
}


# Default model for the Workers AI doer; override per agent with spec["model"] (P3: no model constants outside this file).
DEFAULT_WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
DEFAULT_VERTEX_MODEL = "gemini-2.5-flash"


def workers_ai_vendor(model: str) -> str:
    """Vendor segment of a Workers AI model id ('@cf/<vendor>/<name>'), the model family for pairing checks."""
    parts = model.split("/")
    return parts[1] if len(parts) >= 3 else "workers-ai"


def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in over.items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def load_policy(path: str | None = None) -> dict:
    """Default policy pack, with an optional overlay file merged over it (an overlay changes only the keys it names)."""
    base = json.loads(resources.files("ultrastable").joinpath("data/policy.json").read_text(encoding="utf-8"))
    if path and os.path.exists(path):
        return _merge(base, json.load(open(path, encoding="utf-8")))
    return base


def load_config(path: str | None = None) -> dict:
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    if path and os.path.exists(path):
        user = json.load(open(path, encoding="utf-8"))
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    return cfg
