# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import json, pathlib, unittest

from ultrastable.store import Store, SCHEMA

ROOT = pathlib.Path(__file__).resolve().parents[3]
MAPPED = {
    "agent_issues", "issue_triage", "issue_lifecycle", "decision_log", "work_claims", "tick_runs",
    "trust_ledger", "decision_predictions", "decision_outcomes", "doctrine_proposals", "owner_asks",
    "human_actions",
}
REGISTRIES = {
    "remediation_contracts", "metric_registry", "analytics_metric_triggers", "failure_modes",
    "spof_registry", "belief_registry", "blocker_redteam", "capability_ledger",
    "false_stop_register", "control_registry",
}


class Boundary(unittest.TestCase):
    def test_every_core_table_has_a_home(self):
        tables = set(json.loads((ROOT / "extraction/boundary.json").read_text())["core_tables"])
        self.assertEqual(tables, MAPPED | REGISTRIES)
        doc = (pathlib.Path(__file__).resolve().parents[1] / "docs/CORE-TABLES-MAP.md").read_text()
        for t in tables:
            self.assertIn(t, doc)

    def test_core_never_reads_qnfo_audit(self):
        for f in (ROOT / "runtimes/python/ultrastable").glob("*.py"):
            self.assertNotIn("qnfo-audit", f.read_text(), f.name)

    def test_registry_roundtrip(self):
        s = Store(":memory:")
        s.reg_put("failure_modes", "fm-1", {"probe": "x"}, "2026-11-10 09:00:00")
        s.reg_put("failure_modes", "fm-1", {"probe": "y"}, "2026-11-10 09:01:00")
        self.assertEqual(s.reg_list("failure_modes"), [{"key": "fm-1", "probe": "y"}])
        self.assertIn("registries", SCHEMA)


if __name__ == "__main__":
    unittest.main()
