# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Bootstrap ladder (issue #80): connect-not-paste, alarm tick, and bootstrap trying the rungs automatically."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bootstrap"))
import ladder  # noqa: E402

ACCT = "a" * 32
TEMPLATE = (Path(__file__).resolve().parents[1] / "adapters/cloudflare/wrangler.template.jsonc").read_text(encoding="utf-8")


def fake(outputs):
    calls = []
    def run(cmd, env=None, timeout=None):
        calls.append(cmd[-1])
        out = outputs[cmd[-1]]
        out = out.pop(0) if isinstance(out, list) else out
        return SimpleNamespace(returncode=0, stdout=out, stderr="")
    return run, calls


class Ladder(unittest.TestCase):
    def test_fresh_account_with_no_token_uses_the_connect_rung(self):
        run, _ = fake({"whoami": f"You are logged in with an OAuth Token.\n| Account Name | Account ID |\n| x | {ACCT} |"})
        r = ladder.run_ladder(run, {})
        self.assertEqual(r["route"], "connect")
        self.assertEqual(r["env"], {"CLOUDFLARE_ACCOUNT_ID": ACCT})
        self.assertEqual([a["rung"] for a in r["attempts"]], ["connect", "temporary", "scoped-token"])
        self.assertEqual(r["attempts"][2]["status"], "not_tried")

    def test_no_session_is_one_click_and_every_rung_records_a_reason(self):
        run, calls = fake({"whoami": "You are not authenticated. Please run `wrangler login`."})
        r = ladder.run_ladder(run, {})
        self.assertIsNone(r["route"])
        self.assertTrue(all(a["reason"] for a in r["attempts"]))
        self.assertEqual(r["attempts"][0]["status"], "needs_click")
        self.assertNotIn("login", calls)  # not interactive: never opens a browser unasked
        card = ladder.gate_card(r)
        self.assertIn("wrangler login", card["what"]); self.assertNotIn("token", card["what"].lower())

    def test_interactive_login_then_recheck(self):
        run, calls = fake({"whoami": ["not authenticated", f"logged in OAuth {ACCT}"], "login": ""})
        r = ladder.run_ladder(run, {}, interactive=True)
        self.assertEqual(r["route"], "connect"); self.assertEqual(calls, ["whoami", "login", "whoami"])

    def test_scoped_token_is_the_last_resort_and_secret_values_never_appear(self):
        run, _ = fake({"whoami": ""})
        env = {"CLOUDFLARE_API_TOKEN": "SECRET-VALUE", "CLOUDFLARE_ACCOUNT_ID": ACCT}
        r = ladder.run_ladder(run, env)
        self.assertEqual(r["route"], "scoped-token")
        self.assertNotIn("SECRET-VALUE", repr(r))

    def test_several_accounts_need_a_choice_but_a_set_id_resolves_it(self):
        b = "b" * 32
        run, _ = fake({"whoami": f"logged in OAuth {ACCT} {b}"})
        self.assertEqual(ladder.run_ladder(run, {})["attempts"][0]["status"], "failed")
        self.assertEqual(ladder.run_ladder(run, {"CLOUDFLARE_ACCOUNT_ID": b})["env"], {"CLOUDFLARE_ACCOUNT_ID": b})

    def test_alarm_mode_drops_the_cron_trigger_and_keeps_the_heartbeat_binding(self):
        base = TEMPLATE.replace("{tick_cron}", "*/10 * * * *")
        out = ladder.render_wrangler(base, "alarm")
        self.assertNotIn('"crons"', out); self.assertIn('"TICK_MODE": "alarm"', out)
        self.assertIn('"class_name": "Heartbeat"', out); self.assertIn("new_sqlite_classes", out)
        self.assertIn('"crons"', ladder.render_wrangler(base, "cron"))

    def test_cron_refusal_is_recognized(self):
        self.assertTrue(ladder.is_cron_refusal("A request to the Cloudflare API failed. [code: 10072] cron triggers are not allowed"))
        self.assertFalse(ladder.is_cron_refusal("D1 quota exceeded"))

    def test_bootstrap_apply_falls_back_to_alarm_when_deploy_refuses_cron(self):
        import bootstrap as b
        import tempfile, os, json
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "adapters/cloudflare").mkdir(parents=True)
            (root / "adapters/cloudflare/wrangler.jsonc").write_text(TEMPLATE.replace("{tick_cron}", "* * * * *").replace("{tick_mode}", "cron"))
            boot = b.Boot(root, root / "org", apply=True)
            boot.runtime = {"d1_database": "db", "tick_mode": "cron"}
            boot.connectors_present = set(); boot.tools = {"npx": True}
            boot.state["ladder"] = {"route": "connect", "env": {"CLOUDFLARE_ACCOUNT_ID": ACCT}, "tick_mode": "cron", "attempts": []}
            (root / "org").mkdir(); (root / "org/seed.sql").write_text("")
            deploys = []
            def run(cmd, cwd):
                if cmd[:4] == ["npx", "wrangler", "d1", "list"]: return json.dumps([{"name": "db", "uuid": "0" * 8 + "-0000-0000-0000-" + "0" * 12}])
                if cmd[:3] == ["npx", "wrangler", "deploy"]:
                    deploys.append((root / "adapters/cloudflare/wrangler.jsonc").read_text())
                    if len(deploys) == 1: raise RuntimeError("deploy exited 1: [code: 10072] cron triggers not allowed")
                return ""
            boot.run = run
            status, detail = boot.provision()
            self.assertEqual(status, "ok"); self.assertIn("tick: alarm", detail)
            self.assertIn('"crons"', deploys[0]); self.assertNotIn('"crons"', deploys[1])
            self.assertEqual(boot.start()[0], "ok")


class AccountGuard(unittest.TestCase):
    """Issue #167 (1): the connect rung verifies which account a session reaches and refuses an unintended one."""
    OTHER = "b" * 32

    def test_session_reaching_only_another_account_is_refused(self):
        run, _ = fake({"whoami": f"logged in OAuth {self.OTHER}"})
        r = ladder.run_ladder(run, {}, target=ACCT)
        self.assertIsNone(r["route"]); self.assertEqual(r["attempts"][0]["status"], "failed")
        self.assertIn("refused", r["attempts"][0]["reason"]); self.assertEqual(r["env"], {})
        self.assertEqual(r["account_guard"], {"target": ACCT, "enforced": True})

    def test_target_is_picked_among_several_reachable_accounts(self):
        run, _ = fake({"whoami": f"logged in OAuth {self.OTHER} {ACCT}"})
        r = ladder.run_ladder(run, {}, target=ACCT)
        self.assertEqual(r["route"], "connect"); self.assertEqual(r["env"], {"CLOUDFLARE_ACCOUNT_ID": ACCT})

    def test_env_account_not_reachable_by_the_session_is_refused(self):
        run, _ = fake({"whoami": f"logged in OAuth {ACCT}"})
        r = ladder.run_ladder(run, {"CLOUDFLARE_ACCOUNT_ID": self.OTHER})
        self.assertIsNone(r["route"]); self.assertIn("refused", r["attempts"][0]["reason"])

    def test_scoped_token_for_another_account_is_refused(self):
        run, _ = fake({"whoami": ""})
        r = ladder.run_ladder(run, {"CLOUDFLARE_API_TOKEN": "x", "CLOUDFLARE_ACCOUNT_ID": self.OTHER}, target=ACCT)
        self.assertIsNone(r["route"]); self.assertEqual(r["attempts"][-1]["status"], "failed")
        ok = ladder.run_ladder(run, {"CLOUDFLARE_API_TOKEN": "x", "CLOUDFLARE_ACCOUNT_ID": ACCT}, target=ACCT)
        self.assertEqual(ok["route"], "scoped-token")

    def test_no_target_keeps_the_old_behaviour_and_says_so(self):
        run, _ = fake({"whoami": f"logged in OAuth {ACCT}"})
        r = ladder.run_ladder(run, {})
        self.assertEqual(r["route"], "connect"); self.assertFalse(r["account_guard"]["enforced"])

    def test_target_comes_from_config_then_env(self):
        self.assertEqual(ladder.target_account({"account_id": ACCT.upper()}, {"ULTRASTABLE_TARGET_ACCOUNT_ID": self.OTHER}), ACCT)
        self.assertEqual(ladder.target_account({}, {"ULTRASTABLE_TARGET_ACCOUNT_ID": self.OTHER}), self.OTHER)
        self.assertIsNone(ladder.target_account({}, {}))


class SilentCron(unittest.TestCase):
    """Issue #167 (2): a cron that registered and never fired is detected and the alarm takes over."""
    T0 = "2026-11-12T10:00:00+00:00"

    def at(self, minutes):
        import datetime as dt
        return dt.datetime(2026, 11, 12, 10, 0, tzinfo=dt.timezone.utc) + dt.timedelta(minutes=minutes)

    def test_period_parsing(self):
        self.assertEqual([ladder.cron_period_minutes(c) for c in ("*/30 * * * *", "0 */2 * * *", "* * * * *", None)], [30, 120, 60, 60])

    def test_silent_only_after_two_periods_with_no_tick(self):
        h = {"ok": True, "last_tick": None}
        self.assertFalse(ladder.cron_silent(h, self.T0, self.at(59), "*/30 * * * *"))
        self.assertTrue(ladder.cron_silent(h, self.T0, self.at(60), "*/30 * * * *"))
        self.assertFalse(ladder.cron_silent({"ok": True, "last_tick": {"id": 1}}, self.T0, self.at(600), "*/30 * * * *"))
        self.assertFalse(ladder.cron_silent({"ok": False}, self.T0, self.at(600), "*/30 * * * *"))
        self.assertFalse(ladder.cron_silent(h, "not a date", self.at(600), "*/30 * * * *"))

    def test_floor_applies_to_a_fast_cron(self):
        h = {"ok": True}
        self.assertFalse(ladder.cron_silent(h, self.T0, self.at(14), "*/1 * * * *"))
        self.assertTrue(ladder.cron_silent(h, self.T0, self.at(15), "*/1 * * * *"))


class HeartbeatRedeploy(unittest.TestCase):
    """Issue #167 (3): provisioned_class_missing_from_config on redeploy is recognized and repaired."""
    MSG = "deploy exited 1: Durable Object exports reconciliation failed [provisioned_class_missing_from_config] class Heartbeat"

    def test_recognized(self):
        self.assertTrue(ladder.is_heartbeat_reconcile_failure(self.MSG))
        self.assertFalse(ladder.is_heartbeat_reconcile_failure("D1 quota exceeded"))

    def test_bootstrap_deletes_its_own_worker_and_deploys_fresh_once(self):
        import bootstrap as b, tempfile, json
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "adapters/cloudflare").mkdir(parents=True)
            (root / "adapters/cloudflare/wrangler.jsonc").write_text(TEMPLATE.replace("{tick_cron}", "* * * * *").replace("{tick_mode}", "cron"))
            boot = b.Boot(root, root / "org", apply=True)
            boot.runtime = {"d1_database": "db", "worker_name": "w-self", "tick_mode": "cron"}
            boot.connectors_present = set(); boot.tools = {"npx": True}
            boot.state["ladder"] = {"route": "connect", "env": {"CLOUDFLARE_ACCOUNT_ID": ACCT}, "tick_mode": "cron", "attempts": []}
            (root / "org").mkdir(); (root / "org/seed.sql").write_text("")
            seen = []
            def run(cmd, cwd):
                seen.append(cmd[2])
                if cmd[:4] == ["npx", "wrangler", "d1", "list"]: return json.dumps([{"name": "db", "uuid": "0" * 8 + "-0000-0000-0000-" + "0" * 12}])
                if cmd[2] == "deploy" and seen.count("deploy") == 1: raise RuntimeError(self.MSG)
                if cmd[2] == "delete": self.assertEqual(cmd[3:], ["--name", "w-self", "--force"])
                return ""
            boot.run = run
            status, _ = boot.provision()
            self.assertEqual(status, "ok")
            self.assertEqual([c for c in seen if c in ("deploy", "delete")], ["deploy", "delete", "deploy"])
            self.assertTrue(json.loads((root / "org/ladder.json").read_text())["heartbeat_recreated"])

    def test_a_second_reconcile_failure_is_raised_not_looped(self):
        import bootstrap as b, tempfile
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); (root / "org").mkdir()
            wr = root / "wrangler.jsonc"; wr.write_text("{}")
            boot = b.Boot(root, root / "org", apply=True)
            boot.runtime = {"worker_name": "w"}; boot.state["ladder"] = {"attempts": []}
            def run(cmd, cwd):
                if cmd[2] == "deploy": raise RuntimeError(self.MSG)
                return ""
            boot.run = run
            with self.assertRaises(RuntimeError):
                boot.deploy_with_recovery(["npx", "wrangler", "deploy"], root, wr)


if __name__ == "__main__":
    unittest.main()
