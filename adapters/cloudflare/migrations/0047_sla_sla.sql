-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Service-level policy, audits, objective function and step budgets (US-SPEC-13). Tables are prefixed sla_.
-- Times are YYYY-MM-DD HH:MM:SS, UTC, so they compare as strings (US-00-R05).
CREATE TABLE IF NOT EXISTS sla_rows (
  item_id TEXT PRIMARY KEY,
  severity TEXT NOT NULL DEFAULT 'SEV3',     -- SEV1 | SEV2 | SEV3 | SEV4
  opened_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  exempt TEXT,                               -- calendar | external_event | rate_limited_drain, or NULL
  exempt_reason TEXT,
  raised_for_due TEXT,                       -- the due date this row was last raised for (one raise per missed date)
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sla_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  role TEXT NOT NULL,                        -- the manager notified
  text TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sla_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  checked INTEGER NOT NULL,
  failing INTEGER NOT NULL,                  -- open rows with neither a due date nor an executor
  waiting_on_a_person INTEGER NOT NULL,
  findings TEXT NOT NULL                     -- JSON
);
CREATE TABLE IF NOT EXISTS sla_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  target REAL NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sla_metrics_name ON sla_metrics (name, id);
CREATE TABLE IF NOT EXISTS sla_objective (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  f REAL NOT NULL,                           -- the six-term scalar
  terms TEXT NOT NULL,                       -- JSON: the six terms, each with value and source
  weights TEXT NOT NULL,                     -- JSON: w1..w6 in effect
  calibrated INTEGER NOT NULL DEFAULT 0,
  triad TEXT NOT NULL,                       -- JSON: human_gated, drift, self_healing
  good INTEGER                               -- 1 if the triad moved toward (0, 0, active) since the previous row, 0 if away, NULL if first
);
CREATE TABLE IF NOT EXISTS sla_processes (
  process TEXT PRIMARY KEY,
  done_check TEXT NOT NULL,                  -- defined once per process
  steps TEXT NOT NULL,                       -- JSON: [{ step, budget_hours, paths: [..] }]
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sla_step_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  process TEXT NOT NULL,
  step TEXT NOT NULL,
  ref TEXT,                                  -- what is being processed (an item id)
  budget_hours REAL NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS sla_step_runs_open ON sla_step_runs (finished_at, process, step);
CREATE TABLE IF NOT EXISTS sla_register (
  name TEXT PRIMARY KEY,                     -- weekly_audit | autonomy_card
  last_run_at TEXT,
  next_due_at TEXT NOT NULL
);
