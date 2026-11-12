# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""US-19-R17 (issue #23): bootstrap writes a plain-language owner README, from the same docs/help.md as the console Help tab."""
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bootstrap"))
from ownerdoc import owner_readme, parse_help  # noqa: E402

HELP = (ROOT / "docs" / "help.md").read_text(encoding="utf-8")


class OwnerReadme(unittest.TestCase):
    def test_python_and_javascript_parse_help_identically(self):
        js = subprocess.run(["node", "--input-type=module", "-e",
                             "import {parseHelp} from './tools/build_help.mjs';import {readFileSync} from 'node:fs';"
                             "console.log(JSON.stringify(parseHelp(readFileSync('docs/help.md','utf8'))))"],
                            cwd=ROOT, capture_output=True, text=True, check=True).stdout
        self.assertEqual([(s["title"], s["text"]) for s in json.loads(js)], [(s["title"], s["text"]) for s in parse_help(HELP)])

    def test_readme_lists_the_owner_steps_and_every_help_section(self):
        cards = [{"what": "Approve spending up to 50 USD/month", "default_in_effect": "free tiers only"}]
        r = owner_readme("Acme", "Drills for neighbours.", ["A landing page"], cards, HELP)
        self.assertTrue(r.startswith("# Acme\n"))
        self.assertIn("Drills for neighbours.", r)
        self.assertIn("- A landing page", r)
        self.assertIn("Approve spending up to 50 USD/month. If nothing is done: free tiers only.", r)
        for s in parse_help(HELP):
            self.assertIn("## " + s["title"], r)
            self.assertIn(s["text"], r)

    def test_no_owner_steps_says_so(self):
        self.assertIn("- Nothing right now.", owner_readme("Acme", "", [], [], HELP))

    def test_bootstrap_dry_run_writes_the_readme(self):
        with tempfile.TemporaryDirectory() as t:
            p = subprocess.run([sys.executable, str(ROOT / "bootstrap/bootstrap.py"), "--dry-run", "--out", t], capture_output=True, text=True)
            self.assertEqual(p.returncode, 0, p.stderr[-300:])
            r = (Path(t) / "README.md").read_text(encoding="utf-8")
            self.assertIn("## What only you can do", r)
            self.assertIn("## Keys and secrets", r)
            # plain language: no commands, file names or secret-looking strings for a non-coder
            self.assertIsNone(re.search(r"wrangler|\bnpm\b|\.py\b|\.json\b|`|cfut_|sk-[A-Za-z0-9]{16}", r), "README must stay plain language")


if __name__ == "__main__":
    unittest.main()
