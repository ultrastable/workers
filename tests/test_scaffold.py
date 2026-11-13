# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""GAP-SCAFFOLD-1: an idea file alone must yield the target repository plan and its CI and scheduled-cycle workflows.

Found 2026-11-13 while bootstrapping an external platform built on Ultrastable: the idea file had no way to name
the target GitHub organization or repository, and bootstrap wrote no workflows, so the repository, its CI and its
daily cycle were hand-made. This test fails until bootstrap generates them, lint-clean, from the idea file.
"""
import json, subprocess, sys, tempfile, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bootstrap"))
import bootstrap as bs  # noqa: E402

IDEA = """---
org_name: Example Platform
slug: example-platform
owner: Rowan
owner_contact: set-in-secret-store
github_org: ExampleOrg
repos: example-platform
runtime: python
cycle: daily
cycle_command: python -m example_pkg demo --cycles 1
cycle_ledger: ledger/cycles.jsonl
---

# Idea

A bright-spot finder that runs continuously.

# System test

- Loop: detect, screen, forecast, score, correct
- Measure: false flags under ceiling
- Upkeep: data refresh every cycle
- Run cost: 20 USD a month

# First outcomes

- Every cycle publishes verified findings

# Constraints

- Budget per month: 20 USD
"""


class ScaffoldTests(unittest.TestCase):
    def boot(self):
        d = Path(tempfile.mkdtemp())
        idea = d / "IDEA.md"
        idea.write_text(IDEA)
        out = d / "org"
        r = subprocess.run([sys.executable, str(ROOT / "bootstrap/bootstrap.py"), "--dry-run", "--idea", str(idea), "--out", str(out)],
                           capture_output=True, text=True)
        return out, r

    def test_idea_names_the_target_repository(self):
        out, _ = self.boot()
        plan = json.loads((out / "boot-log.json").read_text())["org_plan"]
        self.assertTrue(any("gh repo create ExampleOrg/example-platform" in p for p in plan), plan)

    def test_workflows_are_generated_and_lint_clean(self):
        out, _ = self.boot()
        wf = out / "scaffold" / "example-platform" / ".github" / "workflows"
        ci, cycle = (wf / "ci.yml").read_text(), (wf / "cycle.yml").read_text()
        self.assertIn("python -m unittest discover", ci)
        self.assertIn("cron:", cycle)
        self.assertIn("workflow_dispatch", cycle)
        self.assertIn("python -m example_pkg demo --cycles 1", cycle)
        self.assertIn("ledger/cycles.jsonl", cycle)
        self.assertIn("# allow-schedule:", cycle)
        for f in (wf / "ci.yml", wf / "cycle.yml"):
            r = subprocess.run([sys.executable, str(ROOT / "tools/workflow_lint.py"), str(f)], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_ledger_is_not_ignored(self):
        out, _ = self.boot()
        gi = (out / "scaffold" / "example-platform" / ".gitignore").read_text()
        self.assertNotIn("ledger", gi)


if __name__ == "__main__":
    unittest.main()
