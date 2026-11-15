# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""US-24-R18: once a repository is public, third-party actions are pinned to a full commit SHA (rule W09, opt-in)."""
import contextlib, io, sys, tempfile, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import workflow_lint as wl  # noqa: E402

HEAD = """name: x
on:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: x
jobs:
  t:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
"""
SHA = "8f4b7f84864484a7bf31766abe9204da3cbe65b3"


def wf(*uses):
    return HEAD + "".join(f"      - uses: {u}\n" for u in uses) + "      - run: echo hi\n"


def rules(text, **kw):
    return sorted({f.split()[1] for f in wl.lint_text(text, **kw)})


class ShaPin(unittest.TestCase):
    def test_us_24_r18_tag_passes_by_default_and_is_w09_when_sha_is_required(self):
        text = wf("actions/checkout@v4")
        self.assertEqual(rules(text), [])
        self.assertEqual(rules(text, require_sha=True), ["W09"])

    def test_us_24_r18_full_sha_passes_and_a_short_sha_does_not(self):
        self.assertEqual(rules(wf(f"actions/checkout@{SHA}  # v4.2.2"), require_sha=True), [])
        self.assertEqual(rules(wf(f"actions/checkout@{SHA[:7]}"), require_sha=True), ["W09"])

    def test_us_24_r18_branch_ref_stays_w06_and_local_actions_are_exempt(self):
        self.assertEqual(rules(wf("actions/checkout@main"), require_sha=True), ["W06"])
        self.assertEqual(rules(wf("./.github/actions/local"), require_sha=True), [])

    def test_us_24_r18_cli_gate_and_report(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "a.yml"
            p.write_text(wf("actions/checkout@v4", f"actions/setup-node@{SHA}"), encoding="utf8")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(wl.main([str(p)]), 0)
                self.assertEqual(wl.main([str(p), "--require-sha"]), 1)
                self.assertEqual(wl.main([str(p), "--sha-report"]), 0)
                self.assertEqual(wl.main([str(p), "--bogus"]), 2)
            text = out.getvalue()
            self.assertIn("actions/checkout@v4", text)
            self.assertNotIn("actions/setup-node", text)
            self.assertIn("1 finding(s) not pinned to a commit SHA", text)

    def test_us_24_r18_real_workflows_have_no_branch_refs_and_the_report_runs(self):
        files = sorted((ROOT / ".github" / "workflows").glob("*.y*ml"))
        self.assertTrue(files)
        for f in files:
            found = wl.lint_text(f.read_text(encoding="utf8"), f.name, require_sha=True)
            self.assertEqual([x for x in found if " W06 " in x], [], f.name)


if __name__ == "__main__":
    unittest.main()
