-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- core/criticality: does this deployment build itself? One row per tick of what moved, and the specification each
-- untargeted item was given so a doer could start on it.
CREATE TABLE IF NOT EXISTS criticality_specs (
  item_id TEXT PRIMARY KEY,
  spec TEXT NOT NULL UNIQUE,         -- US-SPEC-NN
  path TEXT NOT NULL,                -- specs/US-SPEC-NN-slug.md
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS criticality_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  active INTEGER NOT NULL,           -- items in open, ready, claimed, blocked
  takeable INTEGER NOT NULL,         -- ready items a doer can start on (target named) plus items a probe will close
  done_total INTEGER NOT NULL,
  runs_total INTEGER NOT NULL,       -- runner runs ever started
  merged_total INTEGER NOT NULL,     -- verified merges ever recorded
  moved INTEGER NOT NULL,            -- 1 when done, runs or merges rose since the previous row
  regime TEXT NOT NULL,              -- self-sustaining | building | stalled | idle
  cause TEXT                         -- root cause when stalled
);
CREATE TABLE IF NOT EXISTS criticality_retries (
  item_id TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0,      -- times this item was put back after a refused run
  last_at TEXT NOT NULL,
  last_reason TEXT
);
