# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import unittest
from ultrastable.config import load_config
from ultrastable.connectors import GitHubConnector
from ultrastable.engine import Engine
from ultrastable.store import Store


class Fake:
    def __init__(self, pr_state=None, runs=None):
        self.calls, self.pr, self.runs = [], pr_state or {}, runs or []

    def __call__(self, method, path, body=None):
        self.calls.append((method, path))
        if path.startswith("/repos/o/r/issues?"):
            return 200, [{"number": 7, "title": "Do it", "html_url": "u", "body": "**Done check:** tests pass\n**Closing probe:** curl ok"},
                         {"number": 8, "title": "A PR", "html_url": "u2", "body": "", "pull_request": {}}]
        if path == "/repos/o/r/pulls/9" and method == "GET":
            return 200, {"merged": False, "draft": False, "user": {"login": "bot"}, "head": {"sha": "abc"}, **self.pr}
        if path.endswith("/check-runs"):
            return 200, {"check_runs": self.runs}
        if method == "POST" and path == "/repos/o/r/pulls":
            return 201, {"number": 9}
        return 200, {}


GREEN = [{"status": "completed", "conclusion": "success"}]


class Connector(unittest.TestCase):
    def test_items_from_issues_skip_prs_and_parse_fields(self):
        items = GitHubConnector("o/r", Fake()).items()
        self.assertEqual([i["id"] for i in items], ["GH-7"])
        self.assertEqual(items[0]["done_check"], "tests pass")
        self.assertEqual(items[0]["closing_probe"], "curl ok")

    def test_sync_adds_once(self):
        e = Engine(Store(":memory:"), load_config())
        c = GitHubConnector("o/r", Fake())
        self.assertEqual(c.sync(e), 1)
        self.assertEqual(c.sync(e), 0)

    def test_open_pr_is_draft(self):
        f = Fake()
        self.assertEqual(GitHubConnector("o/r", f).open_pr("h", "t", "b"), 9)

    def test_merge_on_green_only(self):
        f = Fake(runs=GREEN)
        self.assertEqual(GitHubConnector("o/r", f, bot_login="bot").merge_if_green(9), (True, "merged"))
        self.assertIn(("PUT", "/repos/o/r/pulls/9/merge"), f.calls)
        for pr, runs, why in [({"draft": True}, GREEN, "draft"),
                              ({}, [{"status": "completed", "conclusion": "failure"}], "checks red"),
                              ({}, [{"status": "in_progress", "conclusion": None}], "checks pending"),
                              ({"user": {"login": "someone"}}, GREEN, "not opened by this connector")]:
            f = Fake(pr_state=pr, runs=runs)
            self.assertEqual(GitHubConnector("o/r", f, bot_login="bot").merge_if_green(9), (False, why))
            self.assertNotIn(("PUT", "/repos/o/r/pulls/9/merge"), f.calls)


if __name__ == "__main__":
    unittest.main()
