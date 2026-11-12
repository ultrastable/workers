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
    (root / "self" / "doors.json").write_text(json.dumps({"prerequisites": [{"id": "cloudflare_access", "what": "Let the system run", "doors": [
        {"id": "browser-assisted", "owner_effort": "sign-in", "status": "built", "how": "Sign in once."},
        {"id": "api-token", "owner_effort": "terminal", "status": "built", "how": "Last resort."}]}]}))
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
            self.assertIn("Do **any one** of these", body)
            self.assertIn("Closing probe: file_exists:org/started.json", body)
            self.assertLess(body.index("browser-assisted"), body.index("api-token"))  # simplest door first
            self.assertNotIn("gh secret set", body.split("api-token")[0])  # a terminal command is never the first thing offered
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

    def test_once_started_a_run_does_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            root, calls, gh = make_root(d), [], FakeGh()
            (root / "org" / "started.json").write_text("{}")
            r = ss.start(self.runner(calls), lambda *a, **k: {}, gh, {}, root, "o/r", NOW)
            self.assertTrue(r["started"]); self.assertEqual(calls, []); self.assertEqual(gh.log, [])

    def test_an_existing_deployment_from_any_door_counts_as_started_with_no_token(self):
        with tempfile.TemporaryDirectory() as d:
            root, calls, gh = make_root(d), [], FakeGh()
            (root / "self" / "worker-url.txt").write_text("https://w.example.workers.dev")
            r = ss.start(self.runner(calls), lambda url, headers=None: {"ok": True}, gh, {}, root, "o/r", NOW)
            self.assertTrue(r["started"]); self.assertEqual(r["via"], "existing-deployment")
            self.assertEqual(calls, []); self.assertTrue((root / "org" / "started.json").exists())

    def test_an_unreachable_or_unhealthy_url_is_not_started_and_falls_through_to_the_other_doors(self):
        with tempfile.TemporaryDirectory() as d:
            root, calls, gh = make_root(d), [], FakeGh()
            (root / "self" / "worker-url.txt").write_text("https://w.example.workers.dev")
            def down(url, headers=None): raise OSError("down")
            r = ss.start(self.runner(calls), down, gh, {}, root, "o/r", NOW)
            self.assertFalse(r["started"]); self.assertEqual(gh.log[0][0], "create")


class SilentCronFallback(unittest.TestCase):
    """Issue #167 (2): self-start notices a cron that never fired and redeploys with the alarm tick."""
    ENV = {"CLOUDFLARE_API_TOKEN": "t", "CLOUDFLARE_ACCOUNT_ID": "a" * 32}

    def started(self, d, at="2026-11-12T10:00:00+00:00", **extra):
        root = make_root(d)
        rec = {"at": at, "worker": "w-self", "applied": True, "worker_url": "https://w-self.x.workers.dev", "tick_mode": "cron", "tick_cron": "*/30 * * * *", **extra}
        (root / "org" / "started.json").write_text(json.dumps(rec))
        return root

    def runner(self, calls):
        def run(cmd, cwd=None, input=None):
            calls.append(cmd); return SimpleNamespace(returncode=0, stdout="", stderr="")
        return run

    def test_silent_cron_after_two_periods_redeploys_in_alarm_mode_once(self):
        with tempfile.TemporaryDirectory() as d:
            root, calls = self.started(d), []
            later = dt.datetime(2026, 11, 12, 11, 5, tzinfo=dt.timezone.utc)
            r = ss.start(self.runner(calls), lambda *a, **k: {"ok": True, "last_tick": None}, FakeGh(), self.ENV, root, "o/r", later)
            self.assertEqual(r["tick_watch"]["fallback"], "alarm")
            self.assertEqual(calls[0][calls[0].index("--tick-mode") + 1], "alarm"); self.assertIn("--apply", calls[0])
            rec = json.loads((root / "org" / "started.json").read_text())
            self.assertEqual(rec["tick_mode"], "alarm"); self.assertEqual(rec["fallback"]["from"], "cron")
            calls.clear()
            self.assertIsNone(ss.start(self.runner(calls), lambda *a, **k: {"ok": True}, FakeGh(), self.ENV, root, "o/r", later)["tick_watch"])
            self.assertEqual(calls, [])

    def test_a_tick_that_ran_or_a_young_deploy_changes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            root, calls = self.started(d), []
            later = dt.datetime(2026, 11, 12, 11, 5, tzinfo=dt.timezone.utc)
            r = ss.start(self.runner(calls), lambda *a, **k: {"ok": True, "last_tick": {"id": 1}}, FakeGh(), self.ENV, root, "o/r", later)
            self.assertFalse(r["tick_watch"]["silent"])
            young = dt.datetime(2026, 11, 12, 10, 20, tzinfo=dt.timezone.utc)
            r = ss.start(self.runner(calls), lambda *a, **k: {"ok": True, "last_tick": None}, FakeGh(), self.ENV, root, "o/r", young)
            self.assertFalse(r["tick_watch"]["silent"]); self.assertEqual(calls, [])

    def test_without_credentials_it_waits_and_never_guesses(self):
        with tempfile.TemporaryDirectory() as d:
            root, calls = self.started(d), []
            later = dt.datetime(2026, 11, 12, 12, 0, tzinfo=dt.timezone.utc)
            r = ss.start(self.runner(calls), lambda *a, **k: {"ok": True}, FakeGh(), {}, root, "o/r", later)
            self.assertTrue(r["tick_watch"]["silent"]); self.assertIn("no deploy credentials", r["tick_watch"]["fallback"]); self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
