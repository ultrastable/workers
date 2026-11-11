# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Postgres adapter for the Store contract (q, one, x, scalar, event, get, put, backup).

The driver is injected: pass `connect` (a zero-argument callable returning a DB-API
connection), or let it import psycopg and read the DSN from the environment variable
named by `dsn_env`. Fails closed when neither exists. No secret value is read here
except through that named variable.
"""
from __future__ import annotations
import json, os, re, threading
from .store import SCHEMA, Store


def to_pg_schema(sql: str) -> str:
    sql = sql.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "BIGSERIAL PRIMARY KEY")
    return sql.replace(" REAL", " DOUBLE PRECISION")


def to_pg_sql(sql: str) -> str:
    return sql.replace("?", "%s")


class PostgresStore(Store):
    def __init__(self, connect=None, dsn_env: str = "DATABASE_URL"):
        self.path = "postgres"
        self.lock = threading.RLock()
        if connect is None:
            dsn = os.environ.get(dsn_env)
            if not dsn:
                raise RuntimeError(f"postgres store needs {dsn_env} in the environment")
            try:
                import psycopg  # type: ignore
            except ImportError as e:
                raise RuntimeError("postgres store needs the psycopg package") from e
            connect = lambda: psycopg.connect(dsn, autocommit=True)
        self._connect = connect
        self.db = connect()
        for stmt in [s for s in to_pg_schema(SCHEMA).split(";") if s.strip()]:
            self._exec(stmt)

    def _exec(self, sql, args=()):
        try:
            cur = self.db.cursor()
            cur.execute(to_pg_sql(sql), args)
            return cur
        except Exception as e:  # noqa: BLE001 - only a dropped connection is retried, once
            if not self._dropped(e):
                raise
            self.db = self._connect()  # reconnect after a dropped connection (restart, idle timeout)
            cur = self.db.cursor()
            cur.execute(to_pg_sql(sql), args)
            return cur

    @staticmethod
    def _dropped(e: Exception) -> bool:
        name = type(e).__name__
        return name in ("OperationalError", "InterfaceError", "AdminShutdown", "ConnectionDoesNotExist") or \
            isinstance(e, (ConnectionError, BrokenPipeError))

    def q(self, sql, *args):
        with self.lock:
            cur = self._exec(sql, args)
            cols = [d[0] for d in cur.description or []]
            return [dict(zip(cols, r)) for r in cur.fetchall()] if cols else []

    def x(self, sql, *args):
        with self.lock:
            m = re.match(r"\s*INSERT\s+INTO\s+(events|outcomes|dispatches|tick_runs)\b", sql, re.I)
            if m and "RETURNING" not in sql.upper():
                cur = self._exec(sql + " RETURNING id", args)
                return cur.fetchone()[0]
            return self._exec(sql, args).rowcount

    def backup(self, dest: str):
        raise NotImplementedError("use pg_dump; the database is managed outside the process")
