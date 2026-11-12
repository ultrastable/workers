# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Offline trial of the bootstrapper (issue #22): a dry run on a copy of the tree renders a wrangler.jsonc that is safe to provision."""
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class BootstrapTrial(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.root = cls.tmp / "r"
        shutil.copytree(ROOT, cls.root, ignore=shutil.ignore_patterns(".git", "node_modules", "__pycache__"))
        cls.run_ = subprocess.run([sys.executable, str(cls.root / "bootstrap/bootstrap.py"), "--dry-run", "--root", str(cls.root), "--out", str(cls.tmp / "out")], capture_output=True, text=True)
        cls.cfg = (cls.root / "adapters/cloudflare/wrangler.jsonc").read_text(encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_dry_run_succeeds(self):
        self.assertEqual(self.run_.returncode, 0, self.run_.stderr[-300:])

    def test_rendered_config_is_safe_to_provision(self):
        self.assertIn('"workers_dev": false', self.cfg)
        self.assertRegex(self.cfg, r'"crons":\s*\["[^"]+"\]')
        self.assertIn('"migrations_dir"', self.cfg)

    def test_database_id_is_a_placeholder_until_provision_fills_it(self):
        self.assertIn("{d1_database_id}", self.cfg)
        src = (ROOT / "bootstrap/bootstrap.py").read_text(encoding="utf-8")
        self.assertIn('.replace("{d1_database_id}", db_id)', src)
        self.assertLess(src.index('"migrations", "apply"'), src.index('"wrangler", "deploy"'))

    def test_dry_run_writes_no_secret(self):
        for f in (self.tmp / "out").rglob("*"):
            if f.is_file():
                self.assertIsNone(re.search(r"cfut_[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9_.-]{20,}", f.read_text(encoding="utf-8", errors="replace")), f.name)


if __name__ == "__main__":
    unittest.main()
