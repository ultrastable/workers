# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Self-start detects a Workers Builds git-import deployment from GitHub check runs and records the start with no token (#90)."""
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


def run_of(name="Workers Builds: ultrastable-self", status="completed", conclusion="success", summary="Deployed to https://ultrastable-self.sub.workers.dev"):
    return {"name": name, "status": status, "conclusion": conclusion, "details_url": "https://dash.cloudflare.com/x", "output": {"title": "ok", "summary": summary, "text": None}}


class Builds(unittest.TestCase):
    def test_url_comes_from_a_successful_workers_builds_run(self):
        self.assertEqual(ss.builds_url([run_of()]), "https://ultrastable-self.sub.workers.dev")

    def test_ignores_other_checks_failed_builds_and_preview_aliases(self):
        self.assertIsNone(ss.builds_url([run_of(name="test")]))
        self.assertIsNone(ss.builds_url([run_of(conclusion="failure")]))
        self.assertIsNone(ss.builds_url([run_of(status="in_progress", conclusion=None)]))
        self.assertIsNone(ss.builds_url([run_of(summary="Preview https://a1b2c3d4-ultrastable-self.sub.workers.dev")]))
        self.assertIsNone(ss.builds_url([run_of(summary="no url here")]))
        self.assertEqual(ss.builds_url([run_of(summary="Preview https://a1b2c3d4-w.sub.workers.dev and prod https://w.sub.workers.dev.")]), "https://w.sub.workers.dev")

    def test_start_records_org_started_json_from_health_with_no_token(self):
        with tempfile.TemporaryDirectory() as d:
            root, calls, gh, asked = make_root(d), [], FakeGh(), []
            def api(path):
                asked.append(path); return {"check_runs": [run_of()]}
            r = ss.start(lambda *a, **k: calls.append(a) or SimpleNamespace(returncode=0), lambda url, headers=None: {"ok": True}, gh, {}, root, "o/r", NOW, gh_api=api)
            self.assertTrue(r["started"]); self.assertEqual(r["via"], "workers-builds")
            self.assertEqual(calls, []); self.assertEqual(gh.log, [])
            rec = json.loads((root / "org" / "started.json").read_text())
            self.assertEqual((rec["via"], rec["health_ok"], rec["worker_url"]), ("workers-builds", True, "https://ultrastable-self.sub.workers.dev"))
            self.assertIn("o/r/commits/main/check-runs", asked[0])

    def test_unhealthy_or_unreadable_falls_through_to_the_other_doors(self):
        for http, api in ((lambda u, headers=None: {"ok": False}, lambda p: {"check_runs": [run_of()]}),
                          (lambda u, headers=None: {"ok": True}, lambda p: (_ for _ in ()).throw(OSError("api down")))):
            with tempfile.TemporaryDirectory() as d:
                root, gh = make_root(d), FakeGh()
                r = ss.start(lambda *a, **k: SimpleNamespace(returncode=0), http, gh, {}, root, "o/r", NOW, gh_api=api)
                self.assertFalse(r["started"]); self.assertFalse((root / "org" / "started.json").exists())
                self.assertEqual(gh.log[0][0], "create")


if __name__ == "__main__":
    unittest.main()
