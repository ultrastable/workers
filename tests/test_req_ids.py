# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""US-19-R19: requirement ids cited in code exist in the specifications."""
import contextlib, io, sys, tempfile, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import req_ids  # noqa: E402

P = "US" + "-"  # fake ids are assembled at run time so this file cites none
F = lambda s: s.replace("@", P)
SPEC = F("# US-SPEC-40\n- **@40-R01 [L1]** A thing MUST hold.\n| @40-R02 | Another |\n- **@40-T01** Run it.\n")


def tree(code: dict):
    d = Path(tempfile.mkdtemp())
    (d / "specs").mkdir(); (d / "code").mkdir()
    (d / "specs" / "US-SPEC-40-thing.md").write_text(SPEC, encoding="utf8")
    for name, text in code.items():
        p = d / "code" / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(F(text), encoding="utf8")
    return d / "specs", d / "code"


class ReqIds(unittest.TestCase):
    def test_us_19_r19_a_cited_id_that_no_specification_defines_is_reported_with_its_files(self):
        specs, code = tree({"a.js": "// @40-R01 and @40-R09\n", "sub/b.py": "# @40-R09, @40-T01\n", "node_modules/x.js": "// @99-R99\n"})
        self.assertEqual(req_ids.defined_ids(specs), {F("@40-R01"), F("@40-R02"), F("@40-T01")})
        self.assertEqual(req_ids.undefined(specs, code), [{"id": F("@40-R09"), "files": ["a.js", "sub/b.py"]}])

    def test_us_19_r19_strict_mode_exits_1_and_a_clean_tree_exits_0(self):
        specs, code = tree({"a.js": "// @40-R03\n"})
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(req_ids.main(["--spec-dir", str(specs), "--code-dir", str(code)]), 0)
            self.assertEqual(req_ids.main(["--spec-dir", str(specs), "--code-dir", str(code), "--strict"]), 1)
        self.assertIn(F("@40-R03: a.js"), out.getvalue())
        specs, code = tree({"a.js": "// @40-R02 only\n"})
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(req_ids.main(["--spec-dir", str(specs), "--code-dir", str(code), "--strict"]), 0)

    def test_us_19_r19_a_missing_specification_directory_is_an_error_not_a_pass(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(req_ids.main(["--spec-dir", tempfile.mkdtemp(), "--code-dir", str(ROOT / "tools")]), 2)

    def test_us_19_r19_this_repository_cites_only_defined_ids(self):
        specs = ROOT.parent / "spec" / "specs"
        if not any(specs.glob("US-SPEC-*.md")):
            self.skipTest("the specifications repository is not checked out beside this one")
        self.assertEqual(req_ids.undefined(specs, ROOT), [])


if __name__ == "__main__":
    unittest.main()
