# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""F-002: required checks before merge. Branch protection is paid on private repositories, so tools/safe_merge.py is the door."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import safe_merge as sm  # noqa: E402


def pr(**kw):
    base = {"state": "OPEN", "isDraft": False, "mergeable": "MERGEABLE", "headRefOid": "abc", "files": [{"path": "core/x.js"}]}
    base.update(kw)
    return base


class RequiredChecks(unittest.TestCase):
    def test_both_required_checks_must_pass(self):
        self.assertTrue(sm.decide(pr(), "success", "success")[0])
        self.assertFalse(sm.decide(pr(), "success", "failure")[0])
        self.assertFalse(sm.decide(pr(), "failure", "success")[0])

    def test_contract_not_completed_refuses_even_for_docs_only(self):
        ok, why = sm.decide(pr(files=[{"path": "README.md"}]), None, None)
        self.assertFalse(ok); self.assertIn("contract", why)
        self.assertTrue(sm.decide(pr(files=[{"path": "README.md"}]), None, "success")[0])

    def test_required_check_names_exist_as_jobs_in_the_workflows(self):
        ci = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        sh = (ROOT / ".github/workflows/selfhost.yml").read_text(encoding="utf-8")
        self.assertIn("\n  test:", ci)
        self.assertIn("\n  contract:", sh)


if __name__ == "__main__":
    unittest.main()
