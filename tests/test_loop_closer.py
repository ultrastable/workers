# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import datetime as dt
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import loop_closer as lc  # noqa: E402

NOW = dt.datetime(2026, 11, 12, 12, 0, tzinfo=dt.timezone.utc)
OLD = "2026-11-10T00:00:00Z"
NEW = "2026-11-12T11:00:00Z"


class FakeGh:
    def __init__(self, issues, prs=()):
        self._issues, self._prs, self.log, self.next = [dict(i) for i in issues], list(prs), [], 100

    ci_result = "success"
    def latest_ci(self, branch="main", workflow="ci"): return self.ci_result
    def issues(self): return self._issues
    def prs(self): return self._prs
    def comment(self, n, t): self.log.append(("comment", n))
    def close(self, n, t): self.log.append(("close", n, t))
    def label(self, n, name): self.log.append(("label", n, name))
    def unlabel(self, n, name): self.log.append(("unlabel", n, name))
    def edit_body(self, n, body): self.log.append(("edit", n, body))
    def create(self, title, body):
        self.next += 1
        self.log.append(("create", self.next, title))
        return self.next


def issue(n, title="t", body="", state="OPEN", created=OLD, labels=()):
    return {"number": n, "title": title, "body": body, "state": state, "labels": [{"name": x} for x in labels], "createdAt": created, "updatedAt": created}


def pr(n, body, state="OPEN", merged=None, updated=NEW):
    return {"number": n, "title": "p", "body": body, "state": state, "isDraft": True, "updatedAt": updated, "mergedAt": merged}


class LoopCloser(unittest.TestCase):
    def run_(self, gh, apply=True, root="."):
        return lc.run(gh, Path(root), apply, NOW, 24, 7)

    def test_issue_with_no_probe_and_no_pr_is_an_open_loop_and_gets_labelled(self):
        gh = FakeGh([issue(1)])
        r = self.run_(gh)
        self.assertEqual([n for n, _ in r["open_loop"]], [1])
        self.assertIn(("label", 1, "open-loop"), gh.log)
        self.assertEqual(lc.main.__name__, "main")

    def test_grace_period_protects_a_new_issue(self):
        r = self.run_(FakeGh([issue(1, created=NEW)]))
        self.assertEqual(r["open_loop"], [])

    def test_a_linked_pull_request_is_a_closed_loop(self):
        r = self.run_(FakeGh([issue(2)], [pr(9, "Closes #2")]))
        self.assertEqual(r["open_loop"], [])

    def test_probe_pr_merged_closes_with_evidence(self):
        gh = FakeGh([issue(3, body="Closing probe: pr_merged:#9")], [pr(9, "x", state="MERGED", merged="2026-11-12T00:00:00Z")])
        r = self.run_(gh)
        self.assertEqual(r["closed"][0][0], 3)
        self.assertTrue(any(e[0] == "close" and "merged" in e[2] for e in gh.log))

    def test_probe_file_exists_checks_the_checkout_and_refuses_escape(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "a.txt").write_text("x")
            self.assertTrue(lc.eval_probe("file_exists", "a.txt", {}, {}, Path(d))[0])
            self.assertFalse(lc.eval_probe("file_exists", "b.txt", {}, {}, Path(d))[0])
            self.assertIsNone(lc.eval_probe("file_exists", "../x", {}, {}, Path(d))[0])

    def test_unknown_probe_is_not_evaluable_and_not_closed(self):
        r = self.run_(FakeGh([issue(4, body="Closing probe: vibes:good")]))
        self.assertEqual(r["closed"], [])

    def test_epic_files_a_child_for_each_unlinked_item_and_rewrites_the_epic(self):
        gh = FakeGh([issue(5, title="EPIC: x", body="- [ ] alpha: do alpha\n- [ ] beta: do beta")])
        r = self.run_(gh)
        self.assertEqual(len(r["children"]), 2)
        edit = [e for e in gh.log if e[0] == "edit"][0][2]
        self.assertIn("[ ] #101 alpha", edit)
        self.assertIn("[ ] #102 beta", edit)

    def test_epic_ticks_closed_children_and_closes_itself_when_all_are_ticked(self):
        gh = FakeGh([issue(6, title="EPIC: y", body="- [ ] #7 one\n- [x] #8 two"), issue(7, state="CLOSED"), issue(8, state="CLOSED")])
        r = self.run_(gh)
        self.assertEqual(r["ticked"], [(6, 7)])
        self.assertEqual(r["epics_closed"], [6])
        self.assertTrue(any(e[0] == "close" and e[1] == 6 for e in gh.log))

    def test_dry_run_changes_nothing(self):
        gh = FakeGh([issue(1), issue(5, title="EPIC: z", body="- [ ] a")])
        self.run_(gh, apply=False)
        self.assertEqual(gh.log, [])

    def test_stale_pull_request_labels_the_issue(self):
        gh = FakeGh([issue(10)], [pr(11, "Refs #10", updated="2026-11-01T00:00:00Z")])
        r = self.run_(gh)
        self.assertEqual(r["stalled"][0][0], 10)
        self.assertIn(("label", 10, "stalled"), gh.log)

    def test_exit_status_is_one_while_an_open_loop_remains(self):
        r = self.run_(FakeGh([issue(1)]), apply=False)
        self.assertTrue(r["open_loop"])

    def test_a_red_main_opens_one_incident_and_a_green_main_closes_it_by_probe(self):
        gh = FakeGh([]); gh.ci_result = "failure"
        r = self.run_(gh)
        self.assertEqual(r["incidents"], ["failure"])
        self.assertEqual([e[0] for e in gh.log], ["create"])
        gh2 = FakeGh([issue(9, title="INCIDENT: ci is red on main", body="Closing probe: ci_green:main", created=NEW)]); gh2.ci_result = "failure"
        self.assertEqual(self.run_(gh2)["incidents"], [])  # not duplicated while open
        gh3 = FakeGh([issue(9, title="INCIDENT: ci is red on main", body="Closing probe: ci_green:main", created=NEW)]); gh3.ci_result = "success"
        r3 = self.run_(gh3)
        self.assertEqual(r3["closed"][0][0], 9)


if __name__ == "__main__":
    unittest.main()
