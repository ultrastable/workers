-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Document gate: every document is traced to work or has a disposition. Idempotent.
CREATE TABLE IF NOT EXISTS docgate_docs (
  store TEXT NOT NULL, key TEXT NOT NULL, size INTEGER, uploaded TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  traced INTEGER NOT NULL DEFAULT 0, disposition TEXT, items_scanned TEXT,
  PRIMARY KEY (store, key)
);
CREATE TABLE IF NOT EXISTS docgate_action_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, store TEXT, key TEXT, section TEXT, line TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS docgate_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, total INTEGER, traced INTEGER, orphans INTEGER, new_docs INTEGER, items_filed INTEGER
);
