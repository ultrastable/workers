# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import json, sys, tempfile, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bootstrap"))
import bootstrap as bs  # noqa: E402
import cases  # noqa: E402

LIB = cases.load_library()


class Library(unittest.TestCase):
    def test_library_is_valid(self):
        self.assertEqual(cases.validate_library(LIB), [])

    def test_every_case_has_routes_and_at_most_one_card(self):
        for c in LIB["cases"]:
            self.assertGreaterEqual(len(c["routes"]), 1, c["id"])
            self.assertIn(type(c.get("owner_card")), (dict, type(None)), c["id"])

    def test_every_case_is_documented(self):
        gaps = (ROOT.parent / "docs/BOOTSTRAP-GAPS.md")
        if gaps.exists():
            text = gaps.read_text()
            for c in LIB["cases"]:
                self.assertIn(c["id"], text, f"{c['id']} missing from docs/BOOTSTRAP-GAPS.md")


class Scenarios(unittest.TestCase):
    def plan(self, **f):
        return cases.plan_cases(f)

    def test_owner_abroad_without_practitioner_routes_around_us_provisional(self):
        p = self.plan(us_domiciled=False, has_us_practitioner=False)
        self.assertIn("BC-1", p["applicable"])
        self.assertIn("FILE-PRIORITY", [c["id"] for c in p["cards"]])
        self.assertTrue(any("home-country or EPO" in r["step"] for r in p["routes"] if r["case"] == "BC-1"))

    def test_us_domiciled_owner_gets_no_filing_blocker(self):
        self.assertNotIn("BC-1", self.plan(us_domiciled=True)["applicable"])

    def test_dead_portal_adds_routes_but_one_filing_card(self):
        p = self.plan(national_patent_portal_ok=False)
        self.assertIn("BC-2", p["applicable"])
        self.assertEqual([c["id"] for c in p["cards"]].count("FILE-PRIORITY"), 1)
        self.assertEqual(next(c for c in p["cards"] if c["id"] == "FILE-PRIORITY")["cases"], ["BC-1", "BC-2"])

    def test_filed_and_everything_present_means_no_cards(self):
        facts = {"us_domiciled": True, "priority_filed": True, "has_entity": True, "has_domain_email": True, "has_org_admin_token": True,
                 "has_sender_identity": True, "has_social_accounts": True, "has_institution": True, "budget_usd_per_month": 100,
                 "funder_sites_reachable": True, "device_reachable": True, "repo_writable": True, "public_disclosure_allowed": True}
        p = self.plan(**facts)
        self.assertEqual((p["applicable"], p["cards"]), ([], []))

    def test_no_entity_no_accounts_no_sender_each_one_card(self):
        p = self.plan(has_entity=False, has_social_accounts=False, has_sender_identity=False)
        ids = [c["id"] for c in p["cards"]]
        for want in ("ENTITY", "ACCOUNTS", "OUT-SENDER"):
            self.assertEqual(ids.count(want), 1)
        self.assertEqual(len(ids), len(set(ids)))

    def test_unknown_facts_are_listed_as_assumed(self):
        p = self.plan(has_entity=True)
        self.assertIn("us_domiciled", p["assumed"]); self.assertNotIn("has_entity", p["assumed"])

    def test_blocked_site_access_routes_to_ci_verification_without_a_card(self):
        p = self.plan(funder_sites_reachable=False)
        self.assertIn("BC-11", p["applicable"])
        self.assertNotIn("BC-11", [x for c in p["cards"] for x in c["cases"]])


class BootStage(unittest.TestCase):
    def test_boot_writes_cases_and_cards_for_a_cold_start(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "org"
            (Path(d) / "facts.json").write_text(json.dumps({"national_patent_portal_ok": False}))
            import shutil
            shutil.copytree(ROOT, Path(d) / "s", dirs_exist_ok=True, ignore=shutil.ignore_patterns(".git", "org", "node_modules", "__pycache__", "config.js", "wrangler.jsonc"))
            (Path(d) / "facts.json").replace(Path(d) / "s" / "facts.json")
            bs.main(["--root", str(Path(d) / "s"), "--out", str(out), "--dry-run"])
            data = json.loads((out / "bootstrap-cases.json").read_text())
            self.assertIn("BC-2", data["applicable"])
            cards = json.loads((out / "gate-cards.json").read_text())
            self.assertEqual([c["id"] for c in cards].count("CASE-FILE-PRIORITY"), 1)
            log = json.loads((out / "boot-log.json").read_text())
            self.assertEqual([s["status"] for s in log["stages"] if s["stage"] == "cases"], ["ok"])


if __name__ == "__main__":
    unittest.main()
