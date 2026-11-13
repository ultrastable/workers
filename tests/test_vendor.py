# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""GAP-VENDOR-1: a vendored copy is self-sufficient (its tests find every file they read) and drift is detected."""
import subprocess, sys, tempfile, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import vendor  # noqa: E402


class Vendor(unittest.TestCase):
    def test_vendored_copy_is_self_sufficient_and_pinned(self):
        with tempfile.TemporaryDirectory() as d:
            dest = Path(d)
            m = vendor.vendor(ROOT, dest)
            self.assertIn("org/second-installation.json", m["files"])
            self.assertEqual(vendor.check(dest), [])
            r = subprocess.run(["node", "--test", "--no-warnings", "core/test/second-installation.test.js"], cwd=dest,
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stdout[-1500:] + r.stderr[-1500:])
            self.assertIn("docs/seed.md", m["files"])
            (dest / "SCOPE.md").write_text("drift")
            self.assertEqual(vendor.check(dest), ["changed SCOPE.md"])

    def test_vendored_gitignore_does_not_hide_org_data(self):
        """#182: a fresh git add of the vendored tree must include org/*.json (CI on a pushed repo reads them)."""
        with tempfile.TemporaryDirectory() as d:
            dest = Path(d)
            vendor.vendor(ROOT, dest)
            subprocess.run(["git", "init", "-q"], cwd=dest, check=True)
            subprocess.run(["git", "add", "-A"], cwd=dest, check=True)
            staged = subprocess.run(["git", "ls-files", "org"], cwd=dest, capture_output=True, text=True).stdout.split()
            self.assertIn("org/second-installation.json", staged)

    def test_subset_discovers_test_dependencies_from_another_cwd(self):
        import os
        old = os.getcwd()
        try:
            os.chdir(tempfile.gettempdir())  # a relative-path bug once failed here (cwd outside the source root)
            self.assertIn("org/second-installation.json", vendor.select(ROOT, subset=True))
        finally:
            os.chdir(old)


if __name__ == "__main__":
    unittest.main()
