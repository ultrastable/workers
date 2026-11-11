# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import json, os, shutil, sys, tempfile, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bootstrap"))
import bootstrap as bs  # noqa: E402

POLICY = json.loads((ROOT / "autonomy/policy.json").read_text())
SETTINGS = json.loads((ROOT / ".claude/settings.json").read_text())


def copy_seed(dst: Path):
    shutil.copytree(ROOT, dst, dirs_exist_ok=True, ignore=shutil.ignore_patterns(".git", "org", "node_modules", "__pycache__", "config.js", "wrangler.jsonc"))


class PolicyTests(unittest.TestCase):
    def test_policy_valid(self):
        self.assertEqual(bs.validate_policy(POLICY), [])

    def test_gated_shell_reachable_actions_have_harness_deny(self):
        deny = set(SETTINGS["permissions"]["deny"])
        for s, a, act in bs.gated_actions(POLICY):
            rules = act.get("harness_deny")
            if s in ("repo", "runtime", "secrets"):
                self.assertTrue(rules, f"{s}.{a} needs harness_deny")
                for r in rules:
                    self.assertIn(r, deny, f"{r} missing from .claude/settings.json")

    def test_money_legal_secrets_never_execute(self):
        for s in ("money", "legal", "secrets", "outreach"):
            self.assertNotEqual(POLICY["surfaces"][s]["max_permission"], "execute")

    def test_interrupt_gate_is_narrow(self):
        # every identity-bound irreversible action exists; no reversible action is identity-bound-only gated
        for s, a, act in bs.gated_actions(POLICY):
            self.assertFalse(act.get("reversible_path"))

    def test_bad_policy_is_caught(self):
        p = json.loads(json.dumps(POLICY))
        p["surfaces"]["money"]["start_rung"] = "autonomous"
        self.assertTrue(bs.validate_policy(p))


class BootTests(unittest.TestCase):
    def boot(self, tmp: Path, env=None):
        copy_seed(tmp)
        for k in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"):
            os.environ.pop(k, None)
        os.environ.update(env or {})
        return bs.main(["--root", str(tmp), "--dry-run"])

    def test_dry_run_boots_with_no_credentials(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(self.boot(Path(d)), 0)
            org = Path(d) / "org"
            for f in ("charter.md", "roles.json", "backlog.json", "gate-cards.json", "seed.sql", "boot-log.json"):
                self.assertTrue((org / f).exists(), f)
            cards = json.loads((org / "gate-cards.json").read_text())
            self.assertTrue(any("CLOUDFLARE_API_TOKEN" in c["what"] for c in cards))
            for c in cards:
                self.assertTrue(c["closing_probe"] and c["default_in_effect"])

    def test_outcomes_become_projects_with_managers(self):
        with tempfile.TemporaryDirectory() as d:
            self.boot(Path(d))
            roles = json.loads((Path(d) / "org/roles.json").read_text())
            self.assertEqual(len([r for r in roles if r["role"] == "project-manager"]), 3)
            items = json.loads((Path(d) / "org/backlog.json").read_text())
            self.assertTrue(all(i["done_check"] for i in items))
            self.assertTrue(any(i["id"] == "KIT-6" for i in items))  # "nothing public" constraint
            self.assertTrue(any(i["id"] == "KIT-7" for i in items))  # analytics are standard issue

    def test_idempotent(self):
        with tempfile.TemporaryDirectory() as d:
            self.boot(Path(d)); a = (Path(d) / "org/backlog.json").read_text()
            bs.main(["--root", d, "--dry-run"]); b = (Path(d) / "org/backlog.json").read_text()
            self.assertEqual(a, b)

    def test_secret_values_never_written(self):
        with tempfile.TemporaryDirectory() as d:
            self.boot(Path(d), {"CLOUDFLARE_API_TOKEN": "SECRET-VALUE-123"})
            for p in Path(d).rglob("*"):
                if p.is_file() and "tests" not in p.parts:
                    self.assertNotIn("SECRET-VALUE-123", p.read_text(errors="ignore"), str(p))

    def test_missing_idea_degrades_not_dies(self):
        with tempfile.TemporaryDirectory() as d:
            copy_seed(Path(d)); (Path(d) / "IDEA.md").unlink()
            self.assertEqual(bs.main(["--root", d, "--dry-run"]), 0)
            self.assertTrue((Path(d) / "org/gate-cards.json").exists())

    def test_budget_selects_model_tier(self):
        with tempfile.TemporaryDirectory() as d:
            copy_seed(Path(d)); p = Path(d) / "IDEA.md"
            p.write_text(p.read_text().replace("50 USD", "0 USD"))
            bs.main(["--root", d, "--dry-run"])
            self.assertIn("claude-haiku-5-5", (Path(d) / "org/charter.md").read_text())

    def test_apply_without_credentials_is_blocked_item_not_crash(self):
        with tempfile.TemporaryDirectory() as d:
            copy_seed(Path(d))
            for k in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"):
                os.environ.pop(k, None)
            rc = bs.main(["--root", d, "--apply"])
            self.assertEqual(rc, 2)
            items = json.loads((Path(d) / "org/backlog.json").read_text())
            self.assertTrue(any(i["id"] == "BOOT-PROVISION" for i in items))
            self.assertIn("BOOT-PROVISION", (Path(d) / "org/seed.sql").read_text())
            self.assertTrue((Path(d) / "org/boot-log.json").exists())


if __name__ == "__main__":
    unittest.main()


class SurfaceTests(BootTests):
    def test_surfaces_and_org_plan_recorded(self):
        with tempfile.TemporaryDirectory() as d:
            self.boot(Path(d))
            log = json.loads((Path(d) / "org" / "boot-log.json").read_text())
            self.assertIn("disk_free_gb", log["surfaces"])
            self.assertTrue(log["org_plan"])
            self.assertTrue({"surfaces", "org"} <= {st["stage"] for st in log["stages"]})

    def test_apply_without_org_token_is_gate_card_not_crash(self):
        with tempfile.TemporaryDirectory() as d:
            copy_seed(Path(d))
            for k in ("ORG_ADMIN_TOKEN", "GH_ORG_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"):
                os.environ.pop(k, None)
            from unittest import mock
            with mock.patch.object(bs.Boot, "_gh_admin_org", staticmethod(lambda: False)):
                bs.main(["--apply", "--root", d])
            log = json.loads((Path(d) / "org" / "boot-log.json").read_text())
            org = [st for st in log["stages"] if st["stage"] == "org"][0]
            self.assertIn(org["status"], ("blocked", "degraded"))


class GhAdminOrgTests(unittest.TestCase):
    """BG-13: a local gh login with admin:org counts as the org-admin credential."""

    def _run(self, rc, out):
        from unittest import mock
        r = mock.Mock(returncode=rc, stdout=out, stderr="")
        with mock.patch.object(bs.shutil, "which", return_value="gh"),              mock.patch.object(bs.subprocess, "run", return_value=r):
            return bs.Boot._gh_admin_org()

    def test_admin_org_scope(self):
        self.assertTrue(self._run(0, "Token scopes: 'admin:org', 'repo'"))

    def test_no_admin_scope(self):
        self.assertFalse(self._run(0, "Token scopes: 'repo'"))

    def test_not_logged_in(self):
        self.assertFalse(self._run(1, "not logged in"))
