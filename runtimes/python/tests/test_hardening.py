# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import io, json, os, threading, unittest, urllib.error
from datetime import datetime, timedelta, timezone
from unittest import mock

from ultrastable.agents import VertexAgent
from ultrastable.config import load_config
from ultrastable.connectors import GitHubConnector
from ultrastable.engine import Engine
from ultrastable.pg_store import PostgresStore
from ultrastable.store import Store
from test_connectors import Fake, GREEN

T0 = datetime(2026, 11, 10, 9, 0, tzinfo=timezone.utc)


class Pending(unittest.TestCase):
    def test_pending_verification_waits_then_closes(self):
        e = Engine(Store(":memory:"), load_config())
        verdicts = [(None, "checks pending"), (None, "checks pending"), (True, "green")]
        e.reviewer.verify = lambda it, res: verdicts.pop(0)
        e.add_item(id="X-1", title="t", owner_role="staff", done_check="d", project=None)
        for i in range(3):
            e.tick(T0 + timedelta(minutes=10 * i))
            if i < 2:
                row = e.s.one("SELECT status, attempts FROM items WHERE id='X-1'")
                self.assertEqual((row["status"], row["attempts"]), ("verify", 0))
                self.assertEqual(e.s.scalar("SELECT COUNT(*) FROM outcomes WHERE item_id='X-1'"), 0)
        self.assertEqual(e.s.one("SELECT status FROM items WHERE id='X-1'")["status"], "done")

    def test_connector_verify_pr(self):
        pend = GitHubConnector("o/r", Fake(runs=[{"status": "in_progress", "conclusion": None}]), bot_login="bot")
        self.assertEqual(pend.verify_pr(9), (None, "checks pending"))
        f = Fake(runs=GREEN)
        self.assertEqual(GitHubConnector("o/r", f, bot_login="bot").verify_pr(9), (True, "merged"))
        red = Fake(runs=[{"status": "completed", "conclusion": "failure"}])
        self.assertEqual(GitHubConnector("o/r", red, bot_login="bot").verify_pr(9), (False, "checks red"))


class VertexRefresh(unittest.TestCase):
    def test_401_refreshes_token_once_and_retries(self):
        tokens = iter(["old", "new"])
        seen = []

        def urlopen(req, timeout=0):
            seen.append(req.get_header("Authorization"))
            if len(seen) == 1:
                raise urllib.error.HTTPError(req.full_url, 401, "expired", {}, io.BytesIO(b""))
            return io.BytesIO(json.dumps({"candidates": [{"content": {"parts": [{"text": "PASS ok"}]}}]}).encode())

        a = VertexAgent("v", project="p", location="l", token_source=lambda: next(tokens))
        with mock.patch("urllib.request.urlopen", urlopen):
            self.assertEqual(a._http("hi"), "PASS ok")
        self.assertEqual(seen, ["Bearer old", "Bearer new"])

    def test_second_401_is_an_error(self):
        def urlopen(req, timeout=0):
            raise urllib.error.HTTPError(req.full_url, 401, "expired", {}, io.BytesIO(b""))
        a = VertexAgent("v", project="p", location="l", token_source=lambda: "t")
        with mock.patch("urllib.request.urlopen", urlopen), self.assertRaises(urllib.error.HTTPError):
            a._http("hi")


class OperationalError(Exception):
    pass


class FakeConn:
    def __init__(self, fail_first=False):
        self.fail, self.sql = fail_first, []

    def cursor(self):
        return self

    def execute(self, sql, args=()):
        if self.fail:
            self.fail = False
            raise OperationalError("server closed the connection")
        self.sql.append(sql)

    description = None

    def fetchall(self):
        return []


class Reconnect(unittest.TestCase):
    def test_dropped_connection_reconnects_once(self):
        conns = [FakeConn(), FakeConn()]
        made = []

        def connect():
            c = conns[len(made)]
            made.append(c)
            return c

        st = PostgresStore(connect)
        conns[0].fail = True
        st.q("SELECT 1")
        self.assertEqual(len(made), 2)
        self.assertTrue(conns[1].sql)

    def test_other_errors_are_not_swallowed(self):
        class Boom(FakeConn):
            def execute(self, sql, args=()):
                if sql.startswith("SELECT 9"):
                    raise ValueError("bad sql")
        st = PostgresStore(lambda: Boom())
        with self.assertRaises(ValueError):
            st.q("SELECT 9")


@unittest.skipUnless(os.environ.get("TEST_DATABASE_URL"), "needs TEST_DATABASE_URL")
class TwoWorkers(unittest.TestCase):
    def test_two_concurrent_workers_write_without_loss(self):
        import psycopg
        url = os.environ["TEST_DATABASE_URL"]
        a = PostgresStore(lambda: psycopg.connect(url, autocommit=True))
        a.x("DELETE FROM events WHERE actor LIKE 'w%'")

        def work(name):
            st = PostgresStore(lambda: psycopg.connect(url, autocommit=True))
            for i in range(25):
                st.event("2026-11-10 09:00:00", name, "tick", None, str(i))

        ts = [threading.Thread(target=work, args=(n,)) for n in ("w1", "w2")]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(a.scalar("SELECT COUNT(*) FROM events WHERE actor IN ('w1','w2')"), 50)


if __name__ == "__main__":
    unittest.main()
