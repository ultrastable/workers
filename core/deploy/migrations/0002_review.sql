-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Two-family review gate of the canonical change path (US-SPEC-07 section 4, US-07-R10, R11). Idempotent.

CREATE TABLE IF NOT EXISTS deploy_review_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id TEXT NOT NULL,
  head TEXT NOT NULL,                      -- the pushed head the review saw
  mode TEXT NOT NULL,                      -- observe | hold | off
  risk_classes TEXT NOT NULL,              -- JSON array; empty = not a risk class
  author_family TEXT,
  reviewer_families TEXT,                  -- JSON array
  status TEXT NOT NULL,                    -- clear | hold | would_hold | skipped | refused | failed_open
  reason TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deploy_review_runs_change ON deploy_review_runs (change_id, id);

CREATE TABLE IF NOT EXISTS deploy_review_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES deploy_review_runs(id),
  reviewer TEXT,
  family TEXT,
  severity_claimed TEXT,
  severity TEXT,                           -- after verification by code
  trigger_text TEXT,
  evidence_line TEXT,
  disposition TEXT NOT NULL,               -- kept | demoted | dropped
  note TEXT
);

CREATE TABLE IF NOT EXISTS deploy_review_holds (
  change_id TEXT NOT NULL,
  head TEXT NOT NULL,
  marker TEXT NOT NULL,                    -- the comment line that starts the review result
  run_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',     -- open | released
  created_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT,
  PRIMARY KEY (change_id, head)
);
