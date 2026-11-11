# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import sys, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import workflow_lint as wl  # noqa: E402

CONC = "concurrency:\n  group: x-${{ github.ref }}\n  cancel-in-progress: true\n"
GOOD = """name: x
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
""" + CONC + """jobs:
  t:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - run: echo hi
"""


def rules(text):
    return sorted({f.split()[1] for f in wl.lint_text(text)})


class LintTests(unittest.TestCase):
    def test_good_workflow_is_clean(self):
        self.assertEqual(wl.lint_text(GOOD), [])

    def test_missing_permissions_concurrency_timeout(self):
        bad = GOOD.replace("permissions:\n  contents: read\n", "").replace(CONC, "").replace("    timeout-minutes: 5\n", "")
        self.assertEqual(rules(bad), ["W01", "W02", "W03"])

    def test_concurrency_justification_comment_is_accepted(self):
        self.assertEqual(wl.lint_text(GOOD.replace(CONC, "# no-concurrency: single manual job\n")), [])

    def test_timeout_over_limit(self):
        self.assertEqual(rules(GOOD.replace("timeout-minutes: 5", "timeout-minutes: 360")), ["W03"])

    def test_schedule_forbidden(self):
        self.assertEqual(rules(GOOD.replace("  push:", "  schedule:\n    - cron: '0 * * * *'\n  push:")), ["W04"])

    def test_commented_schedule_is_ignored(self):
        self.assertEqual(wl.lint_text(GOOD.replace("on:\n", "on:\n  # schedule: none, runs from the tick\n")), [])

    def test_pull_request_target_forbidden(self):
        self.assertIn("W05", rules(GOOD.replace("  pull_request:", "  pull_request_target:")))

    def test_unpinned_actions(self):
        self.assertEqual(rules(GOOD.replace("checkout@v4", "checkout@main")), ["W06"])
        self.assertEqual(rules(GOOD.replace("actions/checkout@v4", "owner/act")), ["W06"])
        self.assertEqual(wl.lint_text(GOOD.replace("actions/checkout@v4", "owner/act@0123456789abcdef0123456789abcdef01234567")), [])
        self.assertEqual(wl.lint_text(GOOD.replace("actions/checkout@v4", "./local-action")), [])

    def test_secret_in_pr_job_needs_guard(self):
        bad = GOOD + "      - run: deploy\n        env: { T: ${{ secrets.TOKEN }} }\n"
        self.assertEqual(rules(bad), ["W07"])
        guarded = bad.replace("    runs-on: ubuntu-latest", "    if: github.event_name == 'workflow_dispatch'\n    runs-on: ubuntu-latest")
        self.assertEqual(wl.lint_text(guarded), [])
        self.assertEqual(wl.lint_text(GOOD + "      - run: gh pr list\n        env: { T: ${{ secrets.GITHUB_TOKEN }} }\n"), [])

    def test_macos_windows_forbidden(self):
        self.assertEqual(rules(GOOD.replace("ubuntu-latest", "macos-latest")), ["W08"])

    def test_real_workflows_pass(self):
        files = sorted((ROOT / ".github/workflows").glob("*.y*ml"))
        self.assertTrue(files)
        for f in files:
            self.assertEqual(wl.lint_text(f.read_text(encoding="utf8"), f.name), [], f.name)


if __name__ == "__main__":
    unittest.main()
