-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Fleet runtime (US-SPEC-11): registry, dispatcher schedule, tasks, run ledger, event envelopes, batches, dead-man alerts. Idempotent.

-- Registry: the census authority (US-11-R02). secret_names holds names only, never values.
CREATE TABLE IF NOT EXISTS fleet_registry (
  name TEXT PRIMARY KEY,
  purpose TEXT, kind TEXT,
  status TEXT NOT NULL DEFAULT 'active',     -- declared: active | paused | retired
  crons TEXT NOT NULL DEFAULT '[]',          -- JSON list of cron expressions
  dependencies TEXT NOT NULL DEFAULT '[]',
  health_url TEXT, autonomy_level TEXT, owner TEXT,
  version TEXT,                              -- semantic version of the canonical source
  source_hash TEXT,                          -- SHA-256 of the canonical copy of the deployed source
  header TEXT,                               -- JSON: purpose, capabilities, deploy_method, canonical_source
  secret_names TEXT NOT NULL DEFAULT '[]',
  flags_source TEXT,                         -- where kill-switch and autonomy flags are read from
  state TEXT,                                -- reconciled: live | drifted | degraded | paused | retired
  state_detail TEXT,
  checked_at TEXT
);

CREATE TABLE IF NOT EXISTS fleet_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  live INTEGER NOT NULL, drifted INTEGER NOT NULL, degraded INTEGER NOT NULL, paused INTEGER NOT NULL, retired INTEGER NOT NULL,
  ghosts INTEGER NOT NULL, unregistered INTEGER NOT NULL, unversioned INTEGER NOT NULL,
  detail TEXT
);

-- Dispatcher schedule: a schedule change is a row write (US-11-R04).
CREATE TABLE IF NOT EXISTS fleet_crons (
  name TEXT PRIMARY KEY,
  expr TEXT NOT NULL,                        -- five-field cron expression, UTC
  task_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_fire TEXT,
  last_fired TEXT
);

CREATE TABLE IF NOT EXISTS fleet_tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                        -- sql | http | ai | workflow
  definition TEXT NOT NULL,                  -- JSON
  enabled INTEGER NOT NULL DEFAULT 1
);

-- Run ledger. The eleven columns of US-SPEC-11 section 6 come first; dispatcher bookkeeping follows.
CREATE TABLE IF NOT EXISTS fleet_runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker TEXT NOT NULL,
  trigger TEXT NOT NULL,                     -- cron | http | event | manual
  ts_start TEXT,
  ts_end TEXT,
  status TEXT NOT NULL,                      -- queued | running | ok | failed
  error_class TEXT,
  summary TEXT,
  evidence_refs TEXT,                        -- JSON list
  parent_run INTEGER,
  cost REAL NOT NULL DEFAULT 0,
  task_id TEXT, cron_name TEXT, scheduler TEXT,
  queued_at TEXT NOT NULL,
  result TEXT,                               -- truncated to 4000 characters
  error TEXT                                 -- truncated to 1000 characters
);
CREATE INDEX IF NOT EXISTS idx_fleet_runs_cron ON fleet_runs(cron_name, ts_start);
CREATE INDEX IF NOT EXISTS idx_fleet_runs_status ON fleet_runs(status, queued_at);

-- Event envelopes: validated before writing; rejects are stored with their error (US-11-R06).
CREATE TABLE IF NOT EXISTS fleet_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT, schema_version TEXT, kind TEXT, ts TEXT,
  emitter TEXT, session TEXT, payload_sha256 TEXT,
  payload TEXT,
  state TEXT NOT NULL,                       -- accepted | rejected
  error TEXT,
  run_id INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_events_accepted ON fleet_events(event_id) WHERE state = 'accepted';

-- Batches: executed + failed + needs_human + no_action = scanned, or the batch is itself a failure (US-11-R07).
CREATE TABLE IF NOT EXISTS fleet_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  executor TEXT NOT NULL,
  run_id INTEGER,
  scanned INTEGER NOT NULL, executed INTEGER NOT NULL, failed INTEGER NOT NULL, needs_human INTEGER NOT NULL, no_action INTEGER NOT NULL,
  gap INTEGER NOT NULL,
  status TEXT NOT NULL,                      -- ok | failed
  unaccounted TEXT                           -- JSON list of item ids, when known
);

-- Declared recurring procedures and which schedulers declare them (US-11-R08, R09).
CREATE TABLE IF NOT EXISTS fleet_procedures (
  name TEXT PRIMARY KEY,
  expr TEXT NOT NULL,
  schedulers TEXT NOT NULL                   -- JSON list of scheduler names
);

CREATE TABLE IF NOT EXISTS fleet_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  procedure TEXT NOT NULL,
  slot TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- stop | single_path
  schedulers TEXT NOT NULL,                  -- JSON: declared
  missing TEXT NOT NULL,                     -- JSON: schedulers with no record in the slot
  priority INTEGER NOT NULL,
  item_id TEXT,
  at TEXT NOT NULL,
  UNIQUE (procedure, slot)
);

-- One acting firing per procedure and slot (US-11-R10).
CREATE TABLE IF NOT EXISTS fleet_slot_claims (
  procedure TEXT NOT NULL,
  slot TEXT NOT NULL,
  scheduler TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (procedure, slot)
);

-- Event-triggered scheduling: an accepted event of a kind starts a task.
CREATE TABLE IF NOT EXISTS fleet_triggers (
  id TEXT PRIMARY KEY,
  event_kind TEXT NOT NULL,
  task_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
