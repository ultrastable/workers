# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Read-only public metrics view (#13): five measures, real sources or an explicit not-measured reason."""
import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import public_metrics as pm  # noqa: E402

NOW = dt.datetime(2026, 11, 12, tzinfo=dt.timezone.utc)
PRS = [
    {"number": 1, "headRefName": "agent/1-a", "state": "MERGED", "mergedAt": "2026-11-12T00:00:00Z"},
    {"number": 2, "headRefName": "agent/2-b", "state": "MERGED", "mergedAt": "2026-11-12T01:00:00Z"},
    {"number": 3, "headRefName": "agent/3-c", "state": "CLOSED", "mergedAt": None},
    {"number": 4, "headRefName": "agent/4-d", "state": "OPEN", "mergedAt": None},
    {"number": 5, "headRefName": "feature/person", "state": "MERGED", "mergedAt": "2026-11-12T01:00:00Z"},
]


class Metrics(unittest.TestCase):
    def test_counts_only_agent_branches_and_separates_rejected_from_open(self):
        self.assertEqual(pm.agent_pr_counts(PRS), {"opened": 4, "merged": 2, "rejected": 1, "open": 1})

    def test_unmeasured_sources_are_null_with_a_reason_not_a_guess(self):
        m = pm.build(PRS, NOW)
        for k in ("remaining_capabilities", "predictions", "money", "autonomy"):
            self.assertIsNone(m[k]); self.assertTrue(m["not_measured"][k].startswith("not measured"))

    def test_money_gives_cost_per_merged_pr_and_flags_a_breach(self):
        m = pm.build(PRS, NOW, spend={"spend_usd": 1.0, "cap_usd": 30})["money"]
        self.assertEqual((m["cost_per_merged_pr_usd"], m["within_cap"]), (0.5, True))
        self.assertFalse(pm.build(PRS, NOW, spend={"spend_usd": 31, "cap_usd": 30})["money"]["within_cap"])
        self.assertIsNone(pm.build([], NOW, spend={"spend_usd": 1})["money"]["cost_per_merged_pr_usd"])

    def test_predictions_hit_rate(self):
        self.assertEqual(pm.build(PRS, NOW, predictions={"made": 4, "right": 3})["predictions"]["hit_rate"], 0.75)
        self.assertIsNone(pm.build(PRS, NOW, predictions={"made": 0, "right": 0})["predictions"]["hit_rate"])

    def test_remaining_and_autonomy_come_from_the_real_sources(self):
        import spec_backlog
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "US-SPEC-01.md").write_text("## Implementation status\n\n| Capability | Status |\n|---|---|\n| a | BUILT x |\n| b | PLANNED |\n| c | RUNNING in fleet |\n", encoding="utf-8")
            rem = spec_backlog.summary(spec_backlog.collect(Path(d)))
        policy = json.loads((ROOT / "autonomy/policy.json").read_text(encoding="utf-8"))
        m = pm.build(PRS, NOW, remaining=rem, policy=policy)
        self.assertEqual(m["remaining_capabilities"]["remaining"], 2)
        self.assertEqual(m["autonomy"]["surfaces"], len(policy["surfaces"]))
        self.assertEqual(m["not_measured"].keys(), {"predictions", "money"})

    def test_html_is_static_escaped_and_script_free(self):
        m = pm.build(PRS, NOW, spend={"spend_usd": 0.0, "cap_usd": 30})
        m["generated_at"] = "<script>alert(1)</script>"
        page = pm.render_html(m)
        self.assertNotIn("<script", page.lower()); self.assertIn("&lt;script&gt;", page)
        self.assertIn("default-src 'none'", page); self.assertIn("4 opened, 2 merged, 1 rejected, 1 open", page)


if __name__ == "__main__":
    unittest.main()
