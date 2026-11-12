# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""The self-start loop leaves a machine-readable record of what each door did on every run (#73)."""
import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import self_start as ss  # noqa: E402
from test_self_start import FakeGh, make_root  # noqa: E402

NOW = dt.datetime(2026, 11, 12, tzinfo=dt.timezone.utc)
LADDER = {"route": None, "attempts": [{"rung": "connect", "status": "needs_click", "reason": "no Cloudflare session"},
                                      {"rung": "scoped-token", "status": "unavailable", "reason": "not set: CLOUDFLARE_API_TOKEN"}]}


def runner(root, calls):
    def run(cmd, cwd=None, input=None):
        calls.append(cmd)
        if cmd[1] == "bootstrap/bootstrap.py":  # the real bootstrap writes org/ladder.json
            (root / "org" / "ladder.json").write_text(json.dumps(LADDER))
        return SimpleNamespace(returncode=0, stdout="", stderr="")
    return run


class Status(unittest.TestCase):
    def test_a_run_that_does_not_start_records_every_door_with_its_reason(self):
        with tempfile.TemporaryDirectory() as d:
            root, calls = make_root(d), []
            r = ss.start(runner(root, calls), lambda *a, **k: {}, FakeGh(), {}, root, "o/r", NOW, gh_api=lambda p: {"check_runs": []})
            self.assertFalse(r["started"])
            rec = json.loads((root / "org" / "start-attempt.json").read_text())
            doors = {x["door"]: x for x in rec["doors"]}
            self.assertIn("no https address", doors["existing-deployment"]["reason"])
            self.assertIn("no successful Workers Builds", doors["workers-builds"]["reason"])
            self.assertEqual(doors["bootstrap-connect"]["reason"], "no Cloudflare session")
            self.assertFalse(doors["bootstrap"]["ok"]); self.assertIn("missing CLOUDFLARE_API_TOKEN", doors["bootstrap"]["reason"])
            self.assertEqual(r["doors"], rec["doors"])

    def test_runs_are_counted_and_first_attempt_time_is_kept(self):
        with tempfile.TemporaryDirectory() as d:
            root, calls = make_root(d), []
            for i in range(3):
                ss.start(runner(root, calls), lambda *a, **k: {}, FakeGh(), {}, root, "o/r", NOW + dt.timedelta(hours=6 * i))
            rec = json.loads((root / "org" / "start-attempt.json").read_text())
            self.assertEqual(rec["runs"], 3)
            self.assertEqual(rec["first_at"], NOW.isoformat())
            self.assertGreater(rec["at"], rec["first_at"])

    def test_unreachable_door_is_named_and_an_unhealthy_apply_keeps_the_doors(self):
        with tempfile.TemporaryDirectory() as d:
            root, calls = make_root(d), []
            (root / "self" / "worker-url.txt").write_text("https://w.example.workers.dev")
            def http(url, headers=None):
                if "subdomain" in url:
                    return {"result": {"subdomain": "sub"}}
                raise OSError("down")
            env = {"CLOUDFLARE_API_TOKEN": "t", "CLOUDFLARE_ACCOUNT_ID": "a"}
            r = ss.start(runner(root, calls), http, FakeGh(), env, root, "o/r", NOW)
            self.assertFalse(r["started"])
            rec = json.loads((root / "org" / "start-attempt.json").read_text())
            self.assertEqual(rec["runs"], 1)
            self.assertIn("unreachable (OSError)", rec["doors"][0]["reason"])
            self.assertFalse(rec["health_ok"])

    def test_the_record_holds_no_secret_value(self):
        with tempfile.TemporaryDirectory() as d:
            root, calls = make_root(d), []
            env = {"CLOUDFLARE_API_TOKEN": "tok-SECRET-9", "CLOUDFLARE_ACCOUNT_ID": "acct"}
            ss.start(runner(root, calls), lambda u, headers=None: {"ok": False}, FakeGh(), env, root, "o/r", NOW)
            self.assertNotIn("SECRET", (root / "org" / "start-attempt.json").read_text())


if __name__ == "__main__":
    unittest.main()
