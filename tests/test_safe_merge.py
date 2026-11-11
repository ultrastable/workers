# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import safe_merge as sm  # noqa: E402


def pr(**kw):
    base = {"state": "OPEN", "isDraft": False, "mergeable": "MERGEABLE", "headRefOid": "abc", "files": [{"path": "core/x.js"}]}
    base.update(kw)
    return base


class SafeMerge(unittest.TestCase):
    def test_merges_only_when_the_test_job_passed_on_the_head_commit(self):
        self.assertTrue(sm.decide(pr(), "success")[0])

    def test_refuses_when_tests_have_not_completed_or_failed(self):
        ok, why = sm.decide(pr(), None)
        self.assertFalse(ok); self.assertIn("not completed", why)
        self.assertFalse(sm.decide(pr(), "failure")[0])

    def test_refuses_drafts_conflicts_and_closed_pull_requests(self):
        self.assertFalse(sm.decide(pr(isDraft=True), "success")[0])
        self.assertFalse(sm.decide(pr(mergeable="CONFLICTING"), "success")[0])
        self.assertFalse(sm.decide(pr(state="MERGED"), "success")[0])

    def test_a_docs_only_change_needs_no_test_run(self):
        self.assertTrue(sm.decide(pr(files=[{"path": "docs/GLOSSARY.md"}, {"path": "README.md"}]), None)[0])
        self.assertFalse(sm.decide(pr(files=[{"path": "docs/a.md"}, {"path": "tools/x.py"}]), None)[0])


if __name__ == "__main__":
    unittest.main()
