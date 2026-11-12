# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas
"""DOC-CONSUMED-1 (owner, 2026-11-12): every document in this repository is consumed by code, a check, an agent instruction or a
generator, and explain-only pages name only files that exist. tools/docs_audit.py is the same stdlib file as in ultrastable/ultrastable."""
import pathlib, subprocess, sys, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class DocsAudit(unittest.TestCase):
    def test_every_document_has_a_consumer(self):
        r = subprocess.run([sys.executable, str(ROOT / "tools/docs_audit.py"), "--root", str(ROOT), "--check"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
