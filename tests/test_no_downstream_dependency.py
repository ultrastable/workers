# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""DEP-DIRECTION-1 (Rowan, 2026-11-13): platforms are built on Ultrastable, never the reverse.
No file in this repository may reference or depend on a downstream platform (Practical Solutions)."""
import subprocess, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
BANNED = ("practical-solutions", "practical_solutions", "practical solutions")


class NoDownstreamDependency(unittest.TestCase):
    def test_no_reference(self):
        files = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split("\n")
        hits = []
        for f in filter(None, files):
            if f == "tests/test_no_downstream_dependency.py":
                continue
            try:
                t = (ROOT / f).read_text(encoding="utf-8").lower()
            except (UnicodeDecodeError, FileNotFoundError):
                continue
            hits += [f for b in BANNED if b in t]
        self.assertEqual(hits, [], "Ultrastable must not reference downstream platforms")


if __name__ == "__main__":
    unittest.main()
