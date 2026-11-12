# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Offline proof for issue #22: `bootstrap.py --temporary` renders a config a temporary Cloudflare account accepts
and provisions it with the --temporary command sequence, with no manual edits and no secret on a command line."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bootstrap"))
import bootstrap as bs  # noqa: E402

TOKEN = "console-key-value-for-test-only"


def copy_tree(dst: Path) -> Path:
    shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns(".git", "node_modules", "__pycache__"))
    return dst


class TemporaryRender(unittest.TestCase):
    def test_dry_run_renders_the_temporary_variant(self):
        with tempfile.TemporaryDirectory() as t:
            root = copy_tree(Path(t) / "r")
            p = subprocess.run([sys.executable, str(root / "bootstrap/bootstrap.py"), "--dry-run", "--temporary",
                                "--root", str(root), "--out", str(Path(t) / "out")], capture_output=True, text=True)
            self.assertEqual(p.returncode, 0, p.stderr[-300:])
            cfg = (root / "adapters/cloudflare/wrangler.jsonc").read_text(encoding="utf-8")
            self.assertIn('"workers_dev": true', cfg)
            self.assertNotIn("crons", cfg)
            self.assertNotIn("triggers", cfg)
            self.assertNotIn("database_id", cfg)
            self.assertNotIn("{d1_database_id}", cfg)
            self.assertIn('"migrations_dir"', cfg)  # the binding stays, so migrations can run
            log = json.loads((Path(t) / "out/boot-log.json").read_text(encoding="utf-8"))
            self.assertTrue(all("--temporary" in c for c in log["provision_plan"]), log["provision_plan"])

    def test_default_render_is_unchanged(self):
        with tempfile.TemporaryDirectory() as t:
            root = copy_tree(Path(t) / "r")
            subprocess.run([sys.executable, str(root / "bootstrap/bootstrap.py"), "--dry-run", "--root", str(root),
                            "--out", str(Path(t) / "out")], capture_output=True, text=True, check=True)
            cfg = (root / "adapters/cloudflare/wrangler.jsonc").read_text(encoding="utf-8")
            self.assertIn('"workers_dev": false', cfg)
            self.assertIn("crons", cfg)
            self.assertIn("{d1_database_id}", cfg)


class TemporaryProvision(unittest.TestCase):
    def boot(self, t, **kw):
        root = copy_tree(Path(t) / "r")
        b = bs.Boot(root, Path(t) / "out", apply=True, temporary=True, **kw)
        for stage in ("read", "detect", "select", "plan", "write"):
            getattr(b, stage)()
        b.tools["npx"] = True
        return b

    def test_apply_runs_deploy_migrations_seed_secret_in_order_and_feeds_the_key_on_stdin(self):
        with tempfile.TemporaryDirectory() as t, mock.patch.dict(os.environ, {"ULTRASTABLE_CONSOLE_TOKEN": TOKEN}):
            b = self.boot(t)
            calls = []
            b.run = lambda cmd, cwd, stdin=None, scrub=None: calls.append((cmd, stdin)) or ""
            status, detail = b.provision()
            self.assertEqual(status, "ok", detail)
            self.assertEqual(calls[0][0][2], "deploy")
            self.assertEqual(calls[1][0][2:6], ["d1", "migrations", "apply", "DB"])
            self.assertIn("d1 execute", " ".join(calls[2][0][2:5]))
            self.assertEqual(calls[3][0][2:5], ["secret", "put", "CONSOLE_TOKEN"])
            self.assertTrue(all("--temporary" in c for c, _ in calls))
            self.assertEqual(calls[3][1], TOKEN + "\n")  # on standard input
            self.assertFalse(any(TOKEN in " ".join(c) for c, _ in calls), "the key is never on a command line")
            self.assertNotIn(TOKEN, detail)

    def test_generated_key_goes_to_a_private_file_not_the_log(self):
        with tempfile.TemporaryDirectory() as t, mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ULTRASTABLE_CONSOLE_TOKEN", None)
            keyfile = Path(t) / "key.txt"
            b = self.boot(t, console_key_file=keyfile)
            seen = []
            b.run = lambda cmd, cwd, stdin=None, scrub=None: seen.append(stdin) or ""
            status, detail = b.provision()
            self.assertEqual(status, "ok", detail)
            key = keyfile.read_text().strip()
            self.assertGreaterEqual(len(key), 24)
            self.assertIn(key + "\n", seen)
            self.assertNotIn(key, detail)

    def test_no_key_source_blocks_with_a_reason_instead_of_running(self):
        with tempfile.TemporaryDirectory() as t, mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ULTRASTABLE_CONSOLE_TOKEN", None)
            b = self.boot(t)
            b.run = lambda *a, **k: self.fail("must not run without a key")
            status, detail = b.provision()
            self.assertEqual(status, "blocked")
            self.assertIn("console key", detail)

    def test_a_failing_command_error_never_contains_the_key(self):
        with tempfile.TemporaryDirectory() as t:
            b = bs.Boot(Path(t), Path(t), apply=True)
            fake = subprocess.CompletedProcess([], 1, "", "failed with " + TOKEN)
            with mock.patch.object(bs.subprocess, "run", return_value=fake):
                with self.assertRaises(RuntimeError) as cm:
                    b.run(["npx", "wrangler", "secret", "put", "X", "--temporary"], t, stdin=TOKEN + "\n", scrub=TOKEN)
            self.assertNotIn(TOKEN, str(cm.exception))
            self.assertIn("[redacted]", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
