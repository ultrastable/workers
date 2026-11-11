-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Ultrastable seed schema v0.1.0. Additive only; later migrations never drop without an R2 export first.

CREATE TABLE IF NOT EXISTS org (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,            -- e.g. project-manager-1
  role TEXT NOT NULL,             -- e.g. project-manager
  project TEXT,                   -- outcome id, null for org-wide roles
  tick_every INTEGER NOT NULL DEFAULT 1,
  model TEXT NOT NULL,
  last_tick_at TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'work',      -- work | plus | fix | amendment | ladder
  project TEXT,
  owner_role TEXT NOT NULL,
  trigger_on TEXT,                        -- item id that must be done first, or null
  done_check TEXT NOT NULL,
  closing_probe TEXT,
  priority INTEGER NOT NULL DEFAULT 50,   -- 0 highest
  status TEXT NOT NULL DEFAULT 'open',    -- open | ready | claimed | done | blocked | superseded | cancelled
  disposition TEXT,                       -- required when status leaves the active set
  blocker TEXT,
  surface TEXT,
  action_class TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS claims (
  item_id TEXT PRIMARY KEY REFERENCES items(id),
  agent TEXT NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gate_cards (
  id TEXT PRIMARY KEY,
  what TEXT NOT NULL,
  why_gated TEXT NOT NULL,
  default_in_effect TEXT NOT NULL,
  prepared_by_fleet TEXT,
  closing_probe TEXT NOT NULL,            -- probe kind: env:<NAME> | item_done:<id> | manual
  status TEXT NOT NULL DEFAULT 'open',    -- open | closed
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS predictions (
  id TEXT PRIMARY KEY,
  item_id TEXT,
  metric TEXT NOT NULL,
  op TEXT NOT NULL,                       -- >= <= > < =
  target REAL NOT NULL,
  due_at TEXT NOT NULL,
  observed REAL,
  verdict TEXT                            -- hit | miss | null until scored
);

CREATE TABLE IF NOT EXISTS outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT,
  agent TEXT,
  surface TEXT NOT NULL,
  action_class TEXT NOT NULL,
  result TEXT NOT NULL,                   -- verified | failed | hidden_failure | silent_drop
  evidence TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trust_ledger (
  surface TEXT NOT NULL,
  action_class TEXT NOT NULL,
  rung TEXT NOT NULL,
  reliability REAL NOT NULL,
  outcomes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (surface, action_class)
);

CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick_id INTEGER NOT NULL,
  role_id TEXT NOT NULL,
  item_id TEXT,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | failed
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tick_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  steps_completed INTEGER NOT NULL DEFAULT 0,
  steps_total INTEGER NOT NULL,
  report TEXT,
  errors TEXT
);

CREATE TABLE IF NOT EXISTS doctrine_lineage (
  version TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  adopted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, priority);
