# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import os, unittest
from ultrastable.pg_store import PostgresStore, to_pg_schema, to_pg_sql
from ultrastable.store import SCHEMA


class Translate(unittest.TestCase):
    def test_schema_and_params(self):
        s = to_pg_schema(SCHEMA)
        self.assertNotIn("AUTOINCREMENT", s)
        self.assertIn("BIGSERIAL PRIMARY KEY", s)
        self.assertEqual(to_pg_sql("SELECT * FROM t WHERE a=? AND b=?"), "SELECT * FROM t WHERE a=%s AND b=%s")

    def test_fails_closed_without_dsn(self):
        os.environ.pop("NO_SUCH_DSN", None)
        with self.assertRaises(RuntimeError):
            PostgresStore(dsn_env="NO_SUCH_DSN")


@unittest.skipUnless(os.environ.get("TEST_DATABASE_URL"), "needs TEST_DATABASE_URL")
class Live(unittest.TestCase):
    def test_contract(self):
        import psycopg
        st = PostgresStore(lambda: psycopg.connect(os.environ["TEST_DATABASE_URL"], autocommit=True))
        st.x("DELETE FROM org")
        st.put("k", {"a": 1})
        self.assertEqual(st.get("k"), {"a": 1})
        st.event("2026-01-01 00:00:00", "t", "k")
        self.assertGreaterEqual(st.scalar("SELECT COUNT(*) FROM events"), 1)


if __name__ == "__main__":
    unittest.main()
