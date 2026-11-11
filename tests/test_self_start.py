# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import self_start as ss  # noqa: E402

NOW = dt.datetime(2026, 11, 12, tzinfo=dt.timezone.utc)
CARDS = [{"id": "GATE-SECRET-X", "what": "Set the X secret", "why_gated": "only the owner", "default_in_effect": "dry run", "closing_probe": "env:X"}]


class FakeGh:
    def __init__(self, issues=()):
        self._i, self.log = list(issues), []
    def issues(self): return self._i
    def create(self, title, body):
        self.log.append(("create", title)); self._i.append({"number": 7, "title": title, "body": body, "state": "OPEN"}); return 7
    def edit_body(self, n, body): self.log.append(("edit", n))


def make_root(d):
    root = Path(d)
    (root / "self").mkdir()
    (root / "self" / "ultrastable.json").write_text(json.dumps({"runtime": {"worker_name": "w-self"}}))
    (root / "org").mkdir()
    (root / "org" / "gate-cards.json").write_text(json.dumps(CARDS))
    return root


class SelfStart(unittest.TestCase):
    def runner(self, calls):
        def run(cmd, cwd=None, input=None):
            calls.append((cmd, input))
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        return run

    def test_without_credentials_it_stays_in_dry_run_and_keeps_one_gate_issue(self):
        with tempfile.TemporaryDirectory() as d:
            root, calls, gh = make_root(d), [], FakeGh()
            r = ss.start(self.runner(calls), lambda *a, **k: {}, gh, {}, root, "o/r", NOW)
            self.assertFalse(r["applied"]); self.assertFalse(r["started"])
            self.assertIn("--dry-run", calls[0][0])
            self.assertEqual(gh.log[0][0], "create")
            body = gh._i[0]["body"]
            self.assertIn("gh secret set CLOUDFLARE_API_TOKEN -R o/r", body)
            self.assertIn("Closing probe: file_exists:org/started.json", body)
            self.assertIn("Workers Scripts: Edit", body)
            self.assertFalse((root / "org" / "started.json").exists())

    def test_a_second_run_updates_the_same_issue_instead_of_filing_another(self):
        with tempfile.TemporaryDirectory() as d:
            root, calls, gh = make_root(d), [], FakeGh()
            ss.start(self.runner(calls), lambda *a, **k: {}, gh, {}, root, "o/r", NOW)
            gh._i[0]["body"] = "stale"
            ss.start(self.runner(calls), lambda *a, **k: {}, gh, {}, root, "o/r", NOW)
            self.assertEqual([e[0] for e in gh.log], ["create", "edit"])
            self.assertEqual(len(gh._i), 1)

    def test_with_credentials_it_applies_puts_worker_secrets_on_stdin_and_records_the_start(self):
        with tempfile.TemporaryDirectory() as d:
            root, calls, gh = make_root(d), [], FakeGh()
            env = {"CLOUDFLARE_API_TOKEN": "tok-SECRET-1", "CLOUDFLARE_ACCOUNT_ID": "acct", "SELF_VCS_TOKEN": "vcs-SECRET-2"}
            def http(url, headers=None):
                return {"result": {"subdomain": "sub"}} if "subdomain" in url else {"ok": True}
            r = ss.start(self.runner(calls), http, gh, env, root, "o/r", NOW)
            self.assertTrue(r["applied"]); self.assertTrue(r["started"])
            self.assertIn("--apply", calls[0][0])
            puts = [c for c in calls if c[0][:4] == ["npx", "wrangler", "secret", "put"]]
            self.assertEqual([c[0][4] for c in puts], ["VCS_TOKEN"]); self.assertEqual(puts[0][1], "vcs-SECRET-2")
            rec = (root / "org" / "started.json").read_text()
            self.assertIn('"health_ok": true', rec)
            self.assertNotIn("SECRET", rec); self.assertNotIn("SECRET", json.dumps(r))  # names only, never values

    def test_an_unhealthy_worker_is_recorded_not_marked_started(self):
        with tempfile.TemporaryDirectory() as d:
            root, calls, gh = make_root(d), [], FakeGh()
            env = {"CLOUDFLARE_API_TOKEN": "t", "CLOUDFLARE_ACCOUNT_ID": "a"}
            def http(url, headers=None):
                if "subdomain" in url:
                    return {"result": {"subdomain": "sub"}}
                raise OSError("down")
            r = ss.start(self.runner(calls), http, gh, env, root, "o/r", NOW)
            self.assertFalse(r["started"])
            self.assertFalse((root / "org" / "started.json").exists())
            self.assertTrue((root / "org" / "start-attempt.json").exists())


if __name__ == "__main__":
    unittest.main()
