# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Org-chart configuration as data (PL-2): roles, objectives, gates and connectors load from files, not code.

load_orgchart(config_path, items_dir) reads an org config (see seed/ultrastable.json) and a directory of work-item
JSON files (see docs/issues/) and returns one validated structure:
  roles       from config["roles"]
  connectors  from config["connectors"]
  capacity    from config["capacity"]
  objectives  workstreams (ws:* labels) with their items, derived from the items
  gates       items that wait on a gate (gate:* labels), with the gate name
Validation errors are collected and raised together as OrgChartError so one run reports every problem.
"""
from __future__ import annotations
import json, re
from pathlib import Path


class OrgChartError(ValueError):
    pass


REQUIRED_TOP = ("roles", "connectors", "capacity", "reporting")
ITEM_FIELDS = ("id", "title", "body", "labels", "milestone")


def _check_config(cfg: dict, errors: list) -> None:
    for k in REQUIRED_TOP:
        if k not in cfg:
            errors.append(f"config: missing '{k}'")
    seen = set()
    for i, r in enumerate(cfg.get("roles", [])):
        for f in ("id", "count", "instructions", "tick_every"):
            if f not in r:
                errors.append(f"roles[{i}]: missing '{f}'")
        if r.get("id") in seen:
            errors.append(f"roles: duplicate id {r.get('id')}")
        seen.add(r.get("id"))
    share = cfg.get("capacity", {}).get("plus_share")
    if share is not None and not (0 <= share <= 1):
        errors.append("capacity.plus_share must be between 0 and 1")


def _field(body: str, name: str):
    m = re.search(r"\*\*" + re.escape(name) + r":\*\*\s*(.+)", body)
    return m.group(1).strip() if m else None


def load_items(items_dir) -> list:
    errors, items = [], []
    for p in sorted(Path(items_dir).glob("*.json")):
        if p.name.startswith("_"):
            continue
        it = json.loads(p.read_text(encoding="utf-8"))
        miss = [f for f in ITEM_FIELDS if f not in it]
        if miss:
            errors.append(f"{p.name}: missing {', '.join(miss)}")
            continue
        body = it["body"]
        it["owner"], it["trigger"], it["done_check"] = _field(body, "Owner"), _field(body, "Trigger"), _field(body, "Done check")
        for f in ("owner", "trigger", "done_check"):
            if not it[f]:
                errors.append(f"{p.name}: body has no '{f}'")
        items.append(it)
    if errors:
        raise OrgChartError("; ".join(errors))
    return items


def load_orgchart(config_path, items_dir) -> dict:
    cfg = json.loads(Path(config_path).read_text(encoding="utf-8"))
    errors: list = []
    _check_config(cfg, errors)
    try:
        items = load_items(items_dir)
    except OrgChartError as e:
        errors.append(str(e))
        items = []
    if errors:
        raise OrgChartError("; ".join(errors))
    objectives: dict = {}
    gates: dict = {}
    for it in items:
        for lab in it["labels"]:
            if lab.startswith("ws:"):
                objectives.setdefault(lab[3:], []).append(it["id"])
            if lab.startswith("gate:"):
                gates.setdefault(lab[5:], []).append(it["id"])
    return {"roles": cfg["roles"], "connectors": cfg["connectors"], "capacity": cfg["capacity"],
            "objectives": objectives, "gates": gates, "items": {it["id"]: it for it in items}}
