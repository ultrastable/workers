# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import json, os, re, tempfile, unittest
from pathlib import Path
from ultrastable.config import load_policy, load_config, DEFAULT_WORKERS_AI_MODEL

PKG = Path(__file__).resolve().parent.parent / "ultrastable"


class PolicyPack(unittest.TestCase):
    def test_default_pack_loads(self):
        p = load_policy()
        for key in ("trust", "ladder", "surfaces"):
            self.assertIn(key, p)

    def test_overlay_changes_only_named_keys(self):
        base = load_policy()
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"trust": {"__overlay_marker": 1}}, f)
        try:
            merged = load_policy(f.name)
        finally:
            os.unlink(f.name)
        self.assertEqual(merged["trust"]["__overlay_marker"], 1)
        self.assertEqual(merged["ladder"], base["ladder"])
        self.assertEqual({k: v for k, v in merged["trust"].items() if k != "__overlay_marker"}, base["trust"])

    def test_config_overlay(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"org_name": "Acme"}, f)
        try:
            self.assertEqual(load_config(f.name)["org_name"], "Acme")
        finally:
            os.unlink(f.name)


class NoHardcodedTenant(unittest.TestCase):
    """P3 closing probe: no hardcoded account, repo, host or model constants in platform/core."""

    def test_no_tenant_constants(self):
        banned = re.compile(r"qnfo|ultrastable/ultrastable|rwnq8|@cf/|claude-(?:opus|sonnet|haiku)|[0-9a-f]{32}")
        for py in PKG.glob("*.py"):
            if py.name == "config.py":
                continue
            for n, line in enumerate(py.read_text(encoding="utf-8").splitlines(), 1):
                self.assertIsNone(banned.search(line), f"{py.name}:{n}: {line.strip()}")

    def test_model_default_lives_in_config(self):
        self.assertTrue(DEFAULT_WORKERS_AI_MODEL.startswith("@cf/"))


if __name__ == "__main__":
    unittest.main()
