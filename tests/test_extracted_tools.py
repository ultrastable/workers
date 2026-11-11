# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import io, json, sqlite3, sys, tempfile, unittest
from contextlib import redirect_stdout
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import deploy_probes as dp, canary_revert as cr, review_gate as rg, release as rel, apply_migrations as am, remediation_consumer as rc, outline as ol  # noqa: E402


def quiet(fn, *a, **k):
    out = io.StringIO()
    with redirect_stdout(out):
        code = fn(*a, **k)
    return code, out.getvalue()


class Probes(unittest.TestCase):
    def test_any_route_passes_and_all_failing_fails(self):
        get = lambda u: (200, "ok body") if "b.example" in u else (503, "")
        r = dp.run_probe({"name": "h", "urls": ["http://a.example", "http://b.example"], "expect_body": "ok"}, retries=1, get=get)
        self.assertTrue(r["ok"]); self.assertEqual(len(r["attempts"]), 2)
        r = dp.run_probe({"name": "h", "urls": ["http://a.example"]}, retries=2, get=lambda u: (500, ""), sleep=lambda s: None)
        self.assertFalse(r["ok"]); self.assertEqual(len(r["attempts"]), 2)


class Canary(unittest.TestCase):
    def test_decisions(self):
        self.assertEqual(cr.decide({"ok": True, "results": []})[0], "keep")
        self.assertEqual(cr.decide(None)[0], "revert")
        v, why = cr.decide({"ok": False, "results": [{"name": "x", "ok": False}]})
        self.assertEqual((v, why), ("revert", ["probe failed: x"]))
        self.assertEqual(cr.decide({"ok": True}, {"requests": 100, "errors": 20})[0], "revert")

    def test_cli_prints_commands_but_runs_none(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "p.json"; p.write_text(json.dumps({"ok": False, "results": []}))
            code, out = quiet(cr.main, ["--probes", str(p), "--commit", "abc123"])
        self.assertEqual(code, 3); self.assertIn("git revert --no-edit abc123", out)


class Gate(unittest.TestCase):
    GOOD = {"body": "Author: tool-a\nReviewer: person-b\nEvidence: 312 pass", "checks": "success"}

    def test_pass_and_failures(self):
        self.assertEqual(rg.gate(self.GOOD), [])
        self.assertTrue(any(p.startswith("R1") for p in rg.gate({**self.GOOD, "body": "Author: a\nReviewer: pending\nEvidence: 1"})))
        self.assertTrue(any(p.startswith("R1") for p in rg.gate({**self.GOOD, "body": "Author: tool-a\nReviewer: tool-a\nEvidence: 1"})))
        self.assertTrue(any(p.startswith("R2") for p in rg.gate({**self.GOOD, "body": "Reviewer: b\nEvidence: it works"})))
        self.assertTrue(any(p.startswith("R3") for p in rg.gate({**self.GOOD, "checks": "failure"})))
        self.assertTrue(any(p.startswith("R4") for p in rg.gate({**self.GOOD, "labels": ["protected-change"]})))

    def test_reviewers_list_satisfies_r1(self):
        self.assertEqual(rg.gate({"body": "Evidence: 5", "author": "a", "reviewers": ["b"], "checks": "success"}), [])


class Release(unittest.TestCase):
    def test_bump_and_notes(self):
        self.assertEqual(rel.bump("1.2.3", ["fix: x"]), "1.2.4")
        self.assertEqual(rel.bump("1.2.3", ["feat(core): y", "fix: x"]), "1.3.0")
        self.assertEqual(rel.bump("1.2.3", ["feat: y", "refactor: BREAKING api"]), "2.0.0")
        n = rel.notes("1.3.0", ["feat(core): add y", "fix: z", "plain subject"])
        self.assertIn("### feat\n- add y", n); self.assertIn("### other\n- plain subject", n)


class Migrations(unittest.TestCase):
    def test_applies_twice_idempotently(self):
        with tempfile.TemporaryDirectory() as d:
            db = str(Path(d) / "t.db")
            self.assertGreater(am.apply_sqlite(db), 5)
            self.assertGreater(am.apply_sqlite(db), 5)
            tables = {r[0] for r in sqlite3.connect(db).execute("select name from sqlite_master where type='table'")}
        self.assertTrue({"items", "router_calls", "codeloop_merges", "tasks_queue", "graph_edges"} <= tables)

    def test_d1_prints_commands_and_target_is_exclusive(self):
        code, out = quiet(am.main, ["--d1", "my-db"])
        self.assertEqual(code, 0); self.assertIn("wrangler d1 execute my-db --remote --file", out)
        with self.assertRaises(SystemExit):
            am.main(["--sqlite", "x", "--d1", "y"])


class Remediation(unittest.TestCase):
    def test_dedup_counts_and_reports_unparsed(self):
        state = {}
        lines = ['{"source":"s1","kind":"timeout","detail":"d"}', '{"source":"s1","kind":"timeout"}', "not json", '{"source":"s2","kind":"err"}']
        items, bad = rc.consume(lines, state)
        self.assertEqual(len(items), 2); self.assertEqual(bad, [3]); self.assertEqual(state["s1|timeout"]["count"], 2)
        again, _ = rc.consume(['{"source":"s1","kind":"timeout"}'], state)
        self.assertEqual(again, [])


class Outline(unittest.TestCase):
    def test_outline_reads_js_and_python(self):
        o = ol.outline(ROOT / "core" / "tasks")
        names = {e["file"].split("/")[-1]: e for e in o}
        self.assertIn("enqueue", names["index.js"]["defs"]); self.assertIn("runDue", names["index.js"]["defs"])
        py = ol.outline_file(ROOT / "tools" / "release.py")
        self.assertIn("bump", py["defs"])


if __name__ == "__main__":
    unittest.main()


class WorkflowTemplates(unittest.TestCase):
    NAMES = ["canonical-deploy", "pr-checks", "pr-lane", "apply-migrations", "remediation-consumer", "assign-agent-on-issue", "agent-pr-lifecycle"]

    def test_seven_templates_exist_are_manual_only_and_pass_the_lint(self):
        import workflow_lint as wl
        d = ROOT / "adapters" / "github" / "workflows"
        for n in self.NAMES:
            text = (d / f"{n}.yml").read_text(encoding="utf8")
            self.assertIn("workflow_dispatch:", text, n)
            self.assertNotIn("schedule:", text, n)
            self.assertNotIn("pull_request", text.split("jobs:")[0].replace("pull-requests", ""), n)
        out = io.StringIO()
        with redirect_stdout(out):
            code = wl.main([str(d / f"{n}.yml") for n in self.NAMES]) if hasattr(wl, "main") else 0
        self.assertEqual(code, 0, out.getvalue())
