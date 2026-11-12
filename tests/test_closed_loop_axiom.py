# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""CLOSED-LOOP-AXIOM must be in every agent instruction file this repository writes or holds."""
import sys, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import sync_agent_files as s  # noqa: E402

MARK = "CLOSED-LOOP-AXIOM"


class Axiom(unittest.TestCase):
    def test_every_generated_instruction_file_carries_it(self):
        for repo in s.REPOS:
            for rel, text in s.files(repo).items():
                if rel in ("CLAUDE.md", "GEMINI.md") or rel.endswith((".md", ".mdc")) and "template" not in rel:
                    if rel in ("CLAUDE.md", "GEMINI.md"):
                        continue
                    self.assertIn(MARK, text, f"{repo}:{rel}")

    def test_every_role_file_carries_it(self):
        roles = list((ROOT / "agents/roles").glob("*.md"))
        self.assertTrue(roles)
        for f in roles:
            self.assertIn(MARK, f.read_text(encoding="utf-8"), f.name)


if __name__ == "__main__":
    unittest.main()
