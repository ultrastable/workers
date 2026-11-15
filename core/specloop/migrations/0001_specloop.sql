-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- core/specloop: the specification-to-code loop (US-SPEC-20 R-stage 3, US-SPEC-22). One row per status line of every
-- specification, refreshed each tick, and one row per sweep. The work items themselves live in `items`.
CREATE TABLE IF NOT EXISTS specloop_lines (
  id TEXT PRIMARY KEY,               -- US-SPEC-NN-k (same ids as tools/spec_backlog.py)
  spec TEXT NOT NULL,
  capability TEXT NOT NULL,
  label TEXT NOT NULL,               -- BUILT | RUNNING_ONLY | PLANNED | NOT COVERED
  truthful INTEGER NOT NULL DEFAULT 1, -- 0 when labelled BUILT but no named path exists
  target TEXT,                       -- file the doer changes (derived, never asked for)
  test TEXT,
  item_id TEXT,                      -- the work item that closes this line, when one is open or was closed
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  built_at TEXT
);
CREATE TABLE IF NOT EXISTS specloop_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  specs INTEGER NOT NULL,
  lines INTEGER NOT NULL,
  built INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  false_built INTEGER NOT NULL,
  filed INTEGER NOT NULL,
  closed INTEGER NOT NULL,
  reopened INTEGER NOT NULL,
  released INTEGER NOT NULL,
  error TEXT
);
