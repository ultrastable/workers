-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Export-before-drop ledger (US-01-R04): one row per table export, with the proof that it was read back. Tables are prefixed export_.
CREATE TABLE IF NOT EXISTS export_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  migration TEXT NOT NULL,                   -- the migration the export precedes
  table_name TEXT NOT NULL,
  object_key TEXT NOT NULL,                  -- where the export sits in the object store
  row_count INTEGER NOT NULL,
  sha256 TEXT NOT NULL,                      -- of the exported body
  verified INTEGER NOT NULL DEFAULT 0,       -- 1 only after the body was read back, parsed and matched
  at TEXT NOT NULL                           -- YYYY-MM-DD HH:MM:SS, UTC (US-00-R05)
);
CREATE INDEX IF NOT EXISTS export_ledger_mig ON export_ledger (migration, table_name, id);
CREATE TABLE IF NOT EXISTS export_migrations (
  name TEXT PRIMARY KEY,
  destructive INTEGER NOT NULL DEFAULT 0,
  tables TEXT,                               -- JSON array of the tables whose data it drops or rewrites
  outcome TEXT NOT NULL,                     -- applied | refused
  reason TEXT,
  at TEXT NOT NULL
);
