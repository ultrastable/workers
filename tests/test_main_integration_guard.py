# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
# Real temporary git repository: two branches that are each green alone but red together (the #146 shape).
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import main_integration_guard as g  # noqa: E402

# The "suite": a table named in tables.txt must not appear in guarded.txt (a new table versus a pack guard).
CHECK = "python -c \"t=open('tables.txt').read().split(); g=open('guarded.txt').read().split(); import sys; sys.exit(1 if set(t)&set(g) else 0)\""


def sh(repo, *a):
    subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.invalid", *a], check=True, capture_output=True)


def commit(repo, branch, files, base="main"):
    sh(repo, "checkout", "-q", "-B", branch, base)
    for n, t in files.items():
        (Path(repo) / n).write_text(t, encoding="utf8")
    sh(repo, "add", "-A")
    sh(repo, "commit", "-q", "-m", branch)


class Guard(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.repo = Path(self.d.name)
        sh(self.repo, "init", "-q", "-b", "main")
        (self.repo / "tables.txt").write_text("items\n")
        (self.repo / "guarded.txt").write_text("claims\n")
        sh(self.repo, "add", "-A")
        sh(self.repo, "commit", "-q", "-m", "init")
        commit(self.repo, "pr-tables", {"tables.txt": "items\ndrafts\n"})
        commit(self.repo, "pr-guard", {"guarded.txt": "claims\ndrafts\n"})
        commit(self.repo, "pr-docs", {"notes.txt": "x\n"})
        sh(self.repo, "checkout", "-q", "main")

    def tearDown(self):
        self.d.cleanup()

    def test_each_green_alone_but_the_pair_breaks_is_named(self):
        for h in ("pr-tables", "pr-guard"):
            self.assertTrue(g.try_set(self.repo, "main", [h], cmd=CHECK)["ok"], h)
        r = g.guard(self.repo, "main", ["pr-docs", "pr-tables", "pr-guard"], cmd=CHECK)
        self.assertFalse(r["ok"])
        self.assertEqual(sorted(r["culprit"]), ["pr-guard", "pr-tables"])
        self.assertIn("together", r["why"])

    def test_unrelated_heads_are_green(self):
        r = g.guard(self.repo, "main", ["pr-docs", "pr-tables"], cmd=CHECK)
        self.assertTrue(r["ok"], r)

    def test_merge_conflict_is_a_break_and_the_working_copy_is_untouched(self):
        commit(self.repo, "pr-a", {"tables.txt": "a\n"})
        commit(self.repo, "pr-b", {"tables.txt": "b\n"})
        sh(self.repo, "checkout", "-q", "main")
        r = g.try_set(self.repo, "main", ["pr-a", "pr-b"], cmd=CHECK)
        self.assertFalse(r["ok"])
        self.assertTrue(r["stage"].startswith("merge"))
        self.assertEqual((self.repo / "tables.txt").read_text(), "items\n")
        wt = subprocess.run(["git", "-C", str(self.repo), "worktree", "list"], capture_output=True, text=True).stdout.strip().splitlines()
        self.assertEqual(len(wt), 1, "scratch worktree removed")

    def test_cli_exit_codes_and_red_base(self):
        self.assertEqual(g.main(["--repo-dir", str(self.repo), "--base", "main", "--head", "pr-docs", "--cmd", CHECK]), 0)
        self.assertEqual(g.main(["--repo-dir", str(self.repo), "--base", "main", "--head", "pr-tables", "--head", "pr-guard", "--cmd", CHECK]), 1)
        self.assertEqual(g.main(["--repo-dir", str(self.repo)]), 2)
        commit(self.repo, "red-main", {"tables.txt": "items\nclaims\n"})
        r = g.guard(self.repo, "red-main", ["pr-docs"], cmd=CHECK)
        self.assertEqual(r["why"], "base is red on its own")


if __name__ == "__main__":
    unittest.main()
