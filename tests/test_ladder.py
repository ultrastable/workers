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


if __name__ == "__main__":
    unittest.main()
