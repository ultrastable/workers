-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Deploy module (US-SPEC-07 section 4). Idempotent. Stores digests and versions only, never artifact bodies or secrets.

CREATE TABLE IF NOT EXISTS deploy_lock (
  unit TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  token TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deploy_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'deploy',     -- deploy | unlogged
  status TEXT NOT NULL,                    -- started | kept | reverted | refused | failed | unlogged
  reason TEXT,
  expected_version TEXT,
  from_version TEXT,
  to_version TEXT,
  artifact_sha256 TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS deploy_ledger_unit ON deploy_ledger (unit, id);

CREATE TABLE IF NOT EXISTS deploy_probe_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL REFERENCES deploy_ledger(id),
  phase TEXT NOT NULL,                     -- before | after
  probe TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deploy_units (
  unit TEXT PRIMARY KEY,
  probes_json TEXT NOT NULL DEFAULT '[]',  -- probe definitions as data
  mode TEXT NOT NULL DEFAULT 'revert'      -- revert | observe
);

CREATE TABLE IF NOT EXISTS deploy_config (
  key TEXT PRIMARY KEY,                    -- e.g. kill_switch = on
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deploy_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                      -- unlogged | gate
  unit TEXT NOT NULL,
  what TEXT NOT NULL,
  default_in_effect TEXT,
  closing_probe TEXT,                      -- manual
  status TEXT NOT NULL DEFAULT 'open',     -- open | closed
  created_at TEXT NOT NULL,
  closed_at TEXT
);
