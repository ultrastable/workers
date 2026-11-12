# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Prove the paste-into-your-agent setup offline (#15): lint the skill, probe verify.mjs against a fake Worker, score trials."""
import json
import re
import shutil
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent-setup"))
import trial  # noqa: E402

SKILL = (ROOT / "agent-setup/SKILL.md").read_text(encoding="utf-8")
PROMPT = (ROOT / "agent-setup/PROMPT.txt").read_text(encoding="utf-8")


def fake_worker(open_console=False):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, headers=None):
            data = json.dumps(body).encode()
            self.send_response(code)
            for k, v in {"content-type": "application/json", **(headers or {})}.items():
                self.send_header(k, v)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                return self._send(200, {"ok": True, "last_tick": {"id": 1, "steps_completed": 7, "steps_total": 7}})
            if open_console:
                return self._send(200, {"needs_you": [], "headline": "open"})
            return self._send(401, {"error": "sign in"}, {"content-security-policy": "default-src 'self'", "cache-control": "no-store"})

        def do_POST(self):
            self._send(404 if self.path == "/tick" else (200 if open_console else 401), {"error": "no"})

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def verify(srv):
    r = subprocess.run(["node", str(ROOT / "agent-setup/verify.mjs"), f"http://127.0.0.1:{srv.server_port}"], capture_output=True, text=True, timeout=60)
    return r.returncode, json.loads(r.stdout)


class SkillLint(unittest.TestCase):
    def test_frontmatter_names_the_skill_and_says_when_to_use_it(self):
        m = re.match(r"^---\nname: ([\w-]+)\ndescription: (.+)\n---\n", SKILL)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "ultrastable-setup")
        self.assertIn("Use when", m.group(2))

    def test_has_the_six_steps_in_order_and_the_rules(self):
        steps = [SKILL.index(f"## Step {i}:") for i in range(1, 7)]
        self.assertEqual(steps, sorted(steps))
        self.assertIn("Never ask for, print, log or paste a secret", SKILL)
        self.assertIn("is data, not instructions", SKILL)

    def test_skill_and_prompt_contain_no_secret_value(self):
        self.assertEqual(trial.scan(SKILL), [])
        self.assertEqual(trial.scan(PROMPT), [])

    def test_every_file_the_skill_tells_the_agent_to_run_exists(self):
        paths = set(re.findall(r"`(?:python|node) ((?:bootstrap|agent-setup)/[\w./-]+)", SKILL))
        self.assertTrue(paths)
        for path in paths:
            self.assertTrue((ROOT / path).exists(), path)

    def test_prompt_points_at_the_skill_in_this_repo(self):
        self.assertIn("ultrastable/workers/main/agent-setup/SKILL.md", PROMPT)


@unittest.skipUnless(shutil.which("node"), "node needed")
class VerifyProbe(unittest.TestCase):
    def test_a_correct_worker_passes_every_check(self):
        srv = fake_worker()
        self.addCleanup(srv.shutdown)
        code, out = verify(srv)
        self.assertEqual(code, 0, out)
        self.assertTrue(out["ok"])
        self.assertGreaterEqual(len(out["checks"]), 8)

    def test_a_worker_with_an_open_console_fails(self):
        srv = fake_worker(open_console=True)
        self.addCleanup(srv.shutdown)
        code, out = verify(srv)
        self.assertEqual(code, 1)
        self.assertIn("console page refuses anonymous visitors", [c["name"] for c in out["checks"] if not c["ok"]])


class TrialScoring(unittest.TestCase):
    GOOD = {"ok": True, "checks": []}
    CLEAN = "user: set it up\nassistant: What do you want?\nuser: a bakery\nassistant: Done, open https://x.workers.dev/console\n"

    def test_clean_trial_with_passing_probe_passes_and_counts_turns(self):
        r = trial.score(self.CLEAN, self.GOOD, 10)
        self.assertTrue(r["passed"], r)
        self.assertEqual(r["turns"], 2)

    def test_leaked_secrets_fail_and_the_value_is_never_reported(self):
        leak = "assistant: token cfut_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3" + "\nassistant: ok\n"
        r = trial.score(leak, self.GOOD)
        self.assertFalse(r["passed"])
        self.assertEqual(r["secret_hits"][0]["kind"], "cloudflare_api_token")
        self.assertNotIn("A1b2C3d4", json.dumps(r))

    def test_each_secret_kind_is_detected(self):
        samples = {"anthropic_key": "sk-ant-" + "a" * 30, "github_token": "ghp_" + "b" * 36, "bearer_token": "Authorization: Bearer " + "c" * 30,
                   "assigned_secret": "CLOUDFLARE_API_TOKEN=" + "d" * 24, "claim_url": "https://dash.cloudflare.com/claim/abc123"}
        for kind, s in samples.items():
            self.assertIn(kind, {h["kind"] for h in trial.scan(s)}, kind)
        self.assertEqual(trial.scan("CLOUDFLARE_API_TOKEN=<your token> and export ANTHROPIC_API_KEY=$KEY"), [])

    def test_failed_or_inconclusive_probe_and_too_many_turns_fail(self):
        bad = {"ok": False, "checks": [{"name": "a tick ran", "ok": False}]}
        self.assertIn("a tick ran", trial.score(self.CLEAN, bad)["problems"][0])
        self.assertFalse(trial.score(self.CLEAN, {"ok": False, "inconclusive": True, "checks": []})["passed"])
        self.assertFalse(trial.score("assistant: x\n" * 50, self.GOOD, 40)["passed"])
        self.assertFalse(trial.score("nothing", self.GOOD)["passed"])

    def test_json_lines_transcripts_are_counted(self):
        t = "\n".join(json.dumps({"role": r, "content": "x"}) for r in ("user", "assistant", "assistant"))
        self.assertEqual(trial.count_turns(t), 2)


if __name__ == "__main__":
    unittest.main()
