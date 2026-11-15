-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Model port and role runtime (US-SPEC-14 section 3). Tables are prefixed modelport_.
CREATE TABLE IF NOT EXISTS modelport_instances (
  role_id TEXT PRIMARY KEY,                  -- one instance per role row
  holder TEXT,                               -- the runtime that holds the instance now
  lease_until TEXT,                          -- YYYY-MM-DD HH:MM:SS, UTC; NULL when idle
  runs INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT
);
CREATE TABLE IF NOT EXISTS modelport_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_id TEXT NOT NULL,
  item_id TEXT,
  alias TEXT,
  model TEXT,
  family TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,                      -- done | failed
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS modelport_runs_role ON modelport_runs (role_id, id);
