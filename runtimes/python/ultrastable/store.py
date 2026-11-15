# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Storage: SQLite behind a thin interface so Postgres/Firestore adapters can replace it."""
from __future__ import annotations
import json, sqlite3, threading
from datetime import datetime, timedelta, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS org (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, outcome TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', weight REAL NOT NULL DEFAULT 1.0);
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, project TEXT, tick_every INTEGER NOT NULL DEFAULT 1,
  model TEXT NOT NULL, last_tick_at TEXT);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'work',
  project TEXT, owner_role TEXT NOT NULL, trigger_on TEXT, done_check TEXT NOT NULL,
  closing_probe TEXT, priority INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'open', disposition TEXT, blocker TEXT,
  surface TEXT, action_class TEXT, attempts INTEGER NOT NULL DEFAULT 0, evidence TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS claims (
  item_id TEXT PRIMARY KEY REFERENCES items(id), agent TEXT NOT NULL,
  claimed_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gate_cards (
  id TEXT PRIMARY KEY, item_id TEXT, what TEXT NOT NULL, why_gated TEXT NOT NULL,
  default_in_effect TEXT NOT NULL, prepared_by_fleet TEXT, closing_probe TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', opened_at TEXT, closed_at TEXT);
CREATE TABLE IF NOT EXISTS predictions (
  id TEXT PRIMARY KEY, item_id TEXT, agent TEXT, metric TEXT NOT NULL, op TEXT NOT NULL,
  target REAL NOT NULL, due_at TEXT NOT NULL, observed REAL, verdict TEXT);
CREATE TABLE IF NOT EXISTS outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT, agent TEXT, surface TEXT NOT NULL,
  action_class TEXT NOT NULL, result TEXT NOT NULL, evidence TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trust_ledger (
  surface TEXT NOT NULL, action_class TEXT NOT NULL, rung TEXT NOT NULL, reliability REAL NOT NULL,
  outcomes INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (surface, action_class));
CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tick_id INTEGER NOT NULL, role_id TEXT NOT NULL,
  item_id TEXT, model TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tick_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT,
  steps_completed INTEGER NOT NULL DEFAULT 0, steps_total INTEGER NOT NULL, report TEXT, errors TEXT);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,
  kind TEXT NOT NULL, item_id TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS amendments (
  id TEXT PRIMARY KEY, target TEXT NOT NULL, pattern TEXT NOT NULL, proposal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed', evidence TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS registries (
  kind TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, key));
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, priority);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(id DESC);
"""

FMT = "%Y-%m-%d %H:%M:%S"


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime(FMT)


def parse(s: str) -> datetime:
    return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)


class Store:
    def __init__(self, path: str = ":memory:"):
        self.path = path
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL" if path != ":memory:" else "PRAGMA journal_mode=MEMORY")
        self.db.executescript(SCHEMA)

    def q(self, sql, *args):
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    def one(self, sql, *args):
        rows = self.q(sql, *args)
        return rows[0] if rows else None

    def x(self, sql, *args):
        with self.lock:
            cur = self.db.execute(sql, args)
            return cur.lastrowid if cur.lastrowid else cur.rowcount

    def scalar(self, sql, *args):
        r = self.one(sql, *args)
        return next(iter(r.values())) if r else None

    def event(self, now: str, actor: str, kind: str, item_id=None, detail=None):
        self.x("INSERT INTO events (at, actor, kind, item_id, detail) VALUES (?,?,?,?,?)",
               now, actor, kind, item_id, detail if isinstance(detail, str) or detail is None else json.dumps(detail))

    def get(self, key, default=None):
        r = self.one("SELECT value FROM org WHERE key=?", key)
        return json.loads(r["value"]) if r else default

    def put(self, key, value):
        self.x("INSERT INTO org (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
               key, json.dumps(value))

    def backup(self, dest: str):
        with self.lock:
            self.db.execute("VACUUM INTO ?", (dest,))

    def reg_put(self, kind: str, key: str, body: dict, now: str):
        """Registry rows (failure modes, spofs, beliefs, ...): one table, JSON body, keyed by kind."""
        self.x("DELETE FROM registries WHERE kind=? AND key=?", kind, key)
        self.x("INSERT INTO registries (kind, key, body, updated_at) VALUES (?,?,?,?)",
               kind, key, json.dumps(body, sort_keys=True), now)

    def reg_list(self, kind: str):
        return [{"key": r["key"], **json.loads(r["body"])} for r in
                self.q("SELECT key, body FROM registries WHERE kind=? ORDER BY key", kind)]
