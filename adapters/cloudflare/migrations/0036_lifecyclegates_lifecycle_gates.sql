-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Management lifecycle, the parts beyond the gate tables of core/kernel (US-SPEC-15 R02, R03, R08..R10, R12..R14).
-- Idempotent. Apply after the seed and kernel migrations (reads kernel_projects, artifacts, kernel_decisions, kernel_metrics).

CREATE TABLE IF NOT EXISTS lifecycle_mode_decisions (       -- A-INI-6
  project_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  rule_mode TEXT NOT NULL,                  -- what the selection rule gave
  reason TEXT NOT NULL,
  overridden INTEGER NOT NULL DEFAULT 0,
  decided_by TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lifecycle_artifact_content (     -- the content a form check read (US-15-R03, R13)
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,                    -- JSON
  at TEXT NOT NULL,
  PRIMARY KEY (project_id, kind)
);

CREATE TABLE IF NOT EXISTS lifecycle_capacity (             -- US-15-R14
  project_id TEXT PRIMARY KEY,
  capacity REAL NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lifecycle_comm_plans (           -- A-PLN-9: how often the status report is due
  project_id TEXT PRIMARY KEY,
  period_h REAL NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lifecycle_status_reports (       -- A-MON-1 with A-MON-2 (variance)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  text TEXT NOT NULL,                       -- four lines
  metrics TEXT NOT NULL,                    -- JSON [{ id, value, op, target, state }]
  variance TEXT NOT NULL,                   -- JSON [{ id, predicted, actual, verdict }]
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_reports ON lifecycle_status_reports(project_id, at);

CREATE TABLE IF NOT EXISTS lifecycle_iterations (           -- A-EXE-4
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  goal TEXT NOT NULL,
  items_taken TEXT NOT NULL,                -- JSON array of item ids
  items_done TEXT,                          -- JSON array, set at the end
  demo_result TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  retro_outcome TEXT,
  retro_items TEXT,                         -- JSON array of the items the retrospective filed
  retro_at TEXT,
  UNIQUE (project_id, n)
);

CREATE TABLE IF NOT EXISTS lifecycle_deliverables (         -- A-EXE-1 with its closing probe (US-15-R08)
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  path_or_ref TEXT NOT NULL,
  closing_probe TEXT NOT NULL,              -- one read-only SELECT returning a column named value; passes when value is 1 or more
  produced_by TEXT NOT NULL,
  probe_run_by TEXT,
  probe_passed INTEGER,
  probe_evidence TEXT,
  probe_at TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lifecycle_scope_decisions (      -- the recorded decision that enables a Capability Pack
  pack TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,
  reason TEXT NOT NULL,
  revert_path TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lifecycle_scope_gate (           -- A-MON-5: out-of-scope requests held and answered
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request TEXT NOT NULL,
  requested_by TEXT,
  project_id TEXT,
  rule TEXT NOT NULL,
  pack TEXT NOT NULL,
  answer TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'held',      -- held | released
  item_id TEXT,                             -- set only when a decision released the request
  at TEXT NOT NULL,
  released_at TEXT
);
