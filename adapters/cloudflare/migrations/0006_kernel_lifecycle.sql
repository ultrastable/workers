-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Lifecycle records (US-SPEC-15 s8). The five table names are normative; extra columns are additions.

CREATE TABLE IF NOT EXISTS kernel_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  program_id TEXT,
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('predictive','agile','hybrid')),
  mode_reason TEXT NOT NULL,
  current_phase TEXT NOT NULL DEFAULT 'initiating',  -- initiating | planning | executing | closing | closed
  readback_at TEXT,                                  -- the person was shown the scope and spec read-back (G2)
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS phases (
  project_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  entered_at TEXT NOT NULL,
  gate_id TEXT,
  gate_passed_at TEXT,
  PRIMARY KEY (project_id, phase)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,                      -- <project>:<kind>
  project_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- catalog id, e.g. A-INI-1
  path_or_ref TEXT NOT NULL,                -- a file or record, never chat (US-15-R05)
  owner_role TEXT NOT NULL,
  reviewed_by TEXT,
  status TEXT NOT NULL DEFAULT 'submitted', -- submitted | reviewed | rejected
  produced_by TEXT,
  produced_model TEXT,
  reviewer_model TEXT,
  done_check TEXT,
  done_check_passed INTEGER NOT NULL DEFAULT 0,
  evidence TEXT,
  updated_at TEXT,
  UNIQUE (project_id, kind)
);

CREATE TABLE IF NOT EXISTS change_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  effect TEXT,
  decision TEXT,                            -- null = pending | approved | rejected
  decided_by TEXT,
  decided_at TEXT,
  revert_path TEXT NOT NULL,
  artifact_kind TEXT,
  new_ref TEXT,
  requested_by TEXT,
  requested_at TEXT
);

CREATE TABLE IF NOT EXISTS risks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  cause TEXT NOT NULL,
  effect TEXT NOT NULL,
  likelihood INTEGER, impact INTEGER,
  response TEXT,
  owner_role TEXT,
  trigger TEXT,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  text TEXT NOT NULL,
  plus_item_id TEXT
);
