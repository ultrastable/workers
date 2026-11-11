# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import selfhost_check as sc  # noqa: E402
import spec_truth as st  # noqa: E402

GOOD = """## What
Adds the claims module.

Item: #2
Spec: US-08-R03, US-SPEC-08
Prediction: core_tests_passing >= 150 within 1 h
Evidence: npm test: core 151 pass, 0 fail
Author: claude-code (sonnet)
Reviewer: codex (different model)
"""


class PullRequestContract(unittest.TestCase):
    def check(self, body=GOOD, author="someone", files=("core/claims/index.js",), labels=()):
        return sc.check(body, author, list(files), list(labels))

    def test_a_complete_record_passes(self):
        self.assertEqual(self.check(), [])

    def test_missing_item_is_refused(self):
        self.assertTrue(any(p.startswith("Item:") for p in self.check(GOOD.replace("Item: #2", "Item: <issue>"))))

    def test_prediction_must_be_checkable_or_na_with_a_reason(self):
        bad = self.check(GOOD.replace("core_tests_passing >= 150 within 1 h", "it will probably work"))
        self.assertTrue(any(p.startswith("Prediction:") for p in bad))
        self.assertEqual(self.check(GOOD.replace("core_tests_passing >= 150 within 1 h", "n/a documentation only")), [])

    def test_evidence_must_be_real_output(self):
        self.assertTrue(any(p.startswith("Evidence:") for p in self.check(GOOD.replace("npm test: core 151 pass, 0 fail", "looks good"))))

    def test_never_review_your_own_work(self):
        body = GOOD.replace("Reviewer: codex (different model)", "Reviewer: claude-code (sonnet)")
        self.assertTrue(any("differ" in p for p in self.check(body)))

    def test_protected_paths_need_a_reason_and_the_label(self):
        probs = self.check(files=["agents/CONTRACT.md", "core/x.js"])
        self.assertTrue(any(p.startswith("Protected-change:") for p in probs))
        self.assertTrue(any("label" in p for p in probs))
        ok = self.check(GOOD + "Protected-change: tightening the review rule after a trial finding\n", files=["agents/CONTRACT.md"], labels=["protected-change"])
        self.assertEqual(ok, [])

    def test_dependency_bots_are_exempt(self):
        self.assertEqual(sc.check("", "dependabot[bot]", ["package.json"], []), [])

    def test_the_guard_files_themselves_are_protected(self):
        self.assertEqual(sorted(sc.protected(["core/test/no-qnfo.test.js", "tools/selfhost_check.py", "README.md"])), ["core/test/no-qnfo.test.js", "tools/selfhost_check.py"])


SPEC = """# US-SPEC-99: Example

## 9. Reference implementation status

- Tick: BUILT in `core/src/tick.js` with tests in `core/test/tick.test.js`.
- Old path: BUILT in `worker/src/tick.js`.
- Vague: BUILT, trust us.
- Mixed: PLANNED; part is BUILT in `core/src/tick.js`.
- Running only: RUNNING in the reference fleet.

## 10. Appendix

- BUILT in `nowhere/at/all.js` (outside the status section, ignored)
"""


class SpecTruth(unittest.TestCase):
    def test_finds_false_built_labels_only_in_the_status_section(self):
        with tempfile.TemporaryDirectory() as d:
            specs, code = Path(d) / "specs", Path(d) / "code"
            (code / "core" / "src").mkdir(parents=True)
            (code / "core" / "src" / "tick.js").write_text("x")
            (code / "core" / "test").mkdir(parents=True)
            (code / "core" / "test" / "tick.test.js").write_text("x")
            specs.mkdir()
            (specs / "US-SPEC-99-example.md").write_text(SPEC, encoding="utf-8")
            f = st.findings(specs, code)
            self.assertEqual([x["line"] for x in f], [6, 7])
            self.assertEqual(f[0]["problem"], "labelled BUILT but none of the named paths exist")
            self.assertEqual(f[1]["problem"], "labelled BUILT but names no file")

    def test_several_code_directories_are_searched(self):
        with tempfile.TemporaryDirectory() as d:
            specs, a, b = Path(d) / "specs", Path(d) / "a", Path(d) / "b"
            for p in (specs, a, b / "docs"):
                p.mkdir(parents=True)
            (b / "docs" / "why.md").write_text("x")
            (specs / "US-SPEC-98-x.md").write_text("## 1. Reference implementation status\n\n- Doc: BUILT in `docs/why.md`.\n", encoding="utf-8")
            self.assertEqual(st.findings(specs, [a, b]), [])
            self.assertEqual(len(st.findings(specs, [a])), 1)


if __name__ == "__main__":
    unittest.main()
