# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import json, threading, unittest, urllib.request
from datetime import datetime, timedelta, timezone

from ultrastable.config import load_config
from ultrastable.demo import run_demo, seed_demo
from ultrastable.engine import Engine, STEP_ORDER, reliability
from ultrastable.store import Store


def engine(**agent_over):
    cfg = load_config()
    cfg["agents"]["doer"].update(agent_over)
    return Engine(Store(":memory:"), cfg)


T0 = datetime(2026, 11, 10, 9, 0, tzinfo=timezone.utc)


class Core(unittest.TestCase):
    def test_tick_runs_all_steps(self):
        e = engine()
        r = e.tick(T0)
        self.assertEqual(r["completed"], len(STEP_ORDER))
        self.assertEqual(r["report"].count("\n"), 3)  # four lines

    def test_work_gets_done_and_has_disposition(self):
        e = engine(fail_rate=0.0, hidden_rate=0.0)
        e.s.x("INSERT INTO projects (id,title,outcome) VALUES ('p','P','o')")
        for i in range(5):
            e.add_item(f"W{i}", f"item {i}", project="p", surface="repo", action_class="branch_commit_push")
        for k in range(4):
            e.tick(T0 + timedelta(minutes=10 * k))
        self.assertEqual(e.s.scalar("SELECT COUNT(*) FROM items WHERE id LIKE 'W%' AND status='done'"), 5)
        self.assertEqual(e.s.scalar("SELECT COUNT(*) FROM items WHERE status='done' AND (disposition IS NULL OR disposition='')"), 0)

    def test_irreversible_identity_bound_opens_gate_not_execution(self):
        e = engine(fail_rate=0.0, hidden_rate=0.0)
        e.add_item("PAY", "Wire the deposit", surface="money", action_class="spend")
        e.tick(T0)
        self.assertEqual(e.s.one("SELECT status FROM items WHERE id='PAY'")["status"], "blocked")
        g = e.s.one("SELECT * FROM gate_cards WHERE item_id='PAY'")
        self.assertEqual(g["status"], "open")
        self.assertEqual(e.s.scalar("SELECT COUNT(*) FROM outcomes WHERE item_id='PAY'"), 0)  # never executed
        e.tick(T0 + timedelta(minutes=10))
        self.assertEqual(e.s.scalar("SELECT COUNT(*) FROM gate_cards WHERE item_id='PAY'"), 1)  # not duplicated
        self.assertTrue(e.resolve_gate("GATE-PAY"))
        e.tick(T0 + timedelta(minutes=20))
        self.assertEqual(e.s.one("SELECT status FROM items WHERE id='PAY'")["status"], "done")

    def test_denied_action_is_blocked_with_disposition(self):
        e = engine()
        e.add_item("FP", "Force push main", surface="repo", action_class="force_push_default_branch")
        e.tick(T0)
        it = e.s.one("SELECT * FROM items WHERE id='FP'")
        self.assertEqual(it["status"], "blocked")
        self.assertIn("denied", it["disposition"])

    def test_failed_review_reopens_then_files_root_cause(self):
        e = engine(fail_rate=1.0)
        e.add_item("X", "always fails", surface="repo", action_class="branch_commit_push")
        for k in range(4):
            e.tick(T0 + timedelta(minutes=10 * k))
        self.assertEqual(e.s.one("SELECT status FROM items WHERE id='X'")["status"], "blocked")
        self.assertTrue(e.s.one("SELECT 1 FROM items WHERE id='FIX-X'"))

    def test_reviewer_catches_hidden_failure_or_audit_does(self):
        e = engine(fail_rate=0.0, hidden_rate=1.0)
        e.reviewer.catch_rate = 0.0  # reviewer misses everything
        e.add_item("H", "looks green", surface="repo", action_class="branch_commit_push")
        for k in range(8):
            e.tick(T0 + timedelta(minutes=10 * k))
        self.assertGreaterEqual(e.s.scalar("SELECT COUNT(*) FROM outcomes WHERE result='hidden_failure'"), 1)

    def test_failures_become_adopted_amendment(self):
        e = engine(fail_rate=0.6)
        seed_demo(e, T0)
        for k in range(30):
            e.tick(T0 + timedelta(minutes=10 * k))
        self.assertGreater(e.s.scalar("SELECT COUNT(*) FROM amendments"), 0)
        self.assertGreater(e.s.get("rules", {"version": 1})["version"], 1)

    def test_step_failure_does_not_stop_the_loop(self):
        e = engine()
        e.audit = lambda c: (_ for _ in ()).throw(RuntimeError("boom"))
        r = e.tick(T0)
        self.assertEqual(r["completed"], len(STEP_ORDER) - 1)
        self.assertTrue(e.s.one("SELECT 1 FROM items WHERE id LIKE 'TICKFAIL-audit%'"))

    def test_trust_math(self):
        tr = {"baseline": 0.5, "prior_weight": 2}
        self.assertAlmostEqual(reliability(0, 0, tr), 0.5)
        self.assertAlmostEqual(reliability(10, 10, tr), 11 / 12)

    def test_promotion_needs_evidence_and_is_reviewed(self):
        e = engine(fail_rate=0.0, hidden_rate=0.0)
        e.s.x("INSERT INTO projects (id,title,outcome) VALUES ('p','P','o')")
        for i in range(26):
            e.add_item(f"W{i}", f"i{i}", project="p", surface="repo", action_class="open_pr")
        for k in range(3):
            e.tick(T0 + timedelta(minutes=10 * k))
        self.assertEqual(e.s.one("SELECT rung FROM trust_ledger WHERE surface='repo' AND action_class='open_pr'")["rung"], "delegated")
        for k in range(3, 26):
            e.tick(T0 + timedelta(minutes=10 * k))
        rung = e.s.one("SELECT rung FROM trust_ledger WHERE surface='repo' AND action_class='open_pr'")["rung"]
        self.assertEqual(rung, "autonomous")  # capped; going higher needs the owner
        self.assertTrue(e.s.one("SELECT 1 FROM gate_cards WHERE item_id LIKE 'LADDER-repo-open_pr-self-directed'"))
        self.assertTrue(e.s.one("SELECT 1 FROM events WHERE kind='rung_changed'"))

    def test_demo_is_healthy(self):
        e = Engine(Store(":memory:"), load_config())
        run_demo(e, 40)
        k = e.state()["kpis"]
        self.assertGreaterEqual(k["items_done"], 20)
        self.assertEqual(k["silent_drops"], 0)
        self.assertGreaterEqual(k["open_gates"], 3)  # 3 owner steps + any scope-widening requests
        self.assertGreater(k["prediction_hit_rate"], 0.6)


class Http(unittest.TestCase):
    def test_server(self):
        from http.server import ThreadingHTTPServer
        from ultrastable.server import make_handler
        e = Engine(Store(":memory:"), load_config())
        seed_demo(e, T0)
        srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(e, "secret"))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{srv.server_port}"
        self.assertIn("ULTRASTABLE", urllib.request.urlopen(base + "/").read().decode())
        self.assertTrue(json.load(urllib.request.urlopen(base + "/healthz"))["ok"])
        req = urllib.request.Request(base + "/tick", method="POST", data=b"{}")
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req)
        self.assertEqual(cm.exception.code, 401)
        req = urllib.request.Request(base + "/tick", method="POST", data=b"{}", headers={"authorization": "Bearer secret"})
        self.assertEqual(json.load(urllib.request.urlopen(req))["completed"], len(STEP_ORDER))
        self.assertEqual(json.load(urllib.request.urlopen(base + "/api/state"))["kpis"]["ticks"], 1)
        srv.shutdown()


if __name__ == "__main__":
    unittest.main()


class PatchAgentTest(unittest.TestCase):
    def test_workers_ai_agent_edits_verifies_and_reverts(self):
        import os, sys, tempfile
        from ultrastable.agents import WorkersAIAgent
        d = tempfile.mkdtemp()
        open(os.path.join(d, "calc.py"), "w").write("def add(a, b):\n    return a - b\n")
        open(os.path.join(d, "t.py"), "w").write("from calc import add\nassert add(2, 3) == 5\n")
        chk = sys.executable.replace(chr(92), '/') + ' t.py'
        good = WorkersAIAgent("a", ["calc.py"], d, chk, transport=lambda p: json.dumps({"calc.py": "def add(a, b):\n    return a + b\n"}))
        it = {"title": "fix add", "done_check": "t passes"}
        ok, _ = good.verify(it, good.do(it))
        self.assertTrue(ok)
        bad = WorkersAIAgent("b", ["calc.py"], d, chk, transport=lambda p: json.dumps({"calc.py": "def add(a, b):\n    return 0\n"}))
        r = bad.do(it)
        ok, _ = bad.verify(it, r)
        self.assertFalse(ok)
        r.revert()
        self.assertIn("a + b", open(os.path.join(d, "calc.py")).read())
        esc = WorkersAIAgent("c", ["calc.py"], d, chk, transport=lambda p: '{"evil.py": "x"}')
        self.assertFalse(esc.do(it).ok)
