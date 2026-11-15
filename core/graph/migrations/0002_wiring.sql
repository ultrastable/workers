-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Wiring graph (US-SPEC-12 Part B): sweeps of deployment metadata, analyses, producer-consumer map, census. Idempotent.

CREATE TABLE IF NOT EXISTS graph_wiring_sweeps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated TEXT NOT NULL,
  account TEXT,                              -- an opaque label from configuration, never an account id in code
  worker_count INTEGER NOT NULL,             -- workers read without error
  errors TEXT NOT NULL,                      -- JSON [{worker, error}]: listed, excluded from counts
  workers TEXT NOT NULL                      -- JSON [{name, version, crons, routes, queue_consumers, bindings, tables}]
);

CREATE TABLE IF NOT EXISTS graph_wiring_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sweep_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  nodes INTEGER NOT NULL, edges INTEGER NOT NULL, density REAL NOT NULL,
  islands INTEGER NOT NULL, sinks INTEGER NOT NULL, sources INTEGER NOT NULL, unresolved INTEGER NOT NULL,
  ghosts INTEGER NOT NULL, unregistered INTEGER NOT NULL, unversioned INTEGER NOT NULL,
  data_flow_edges INTEGER NOT NULL, islands_with_data_flow INTEGER NOT NULL,
  orphan_tables INTEGER NOT NULL,
  integration_score REAL NOT NULL,
  detail TEXT NOT NULL
);

-- Producer-consumer map: one row per (resource, worker, mode).
CREATE TABLE IF NOT EXISTS graph_wiring_access (
  sweep_id INTEGER NOT NULL,
  resource TEXT NOT NULL,                    -- table:<name> | queue:<name>
  worker TEXT NOT NULL,
  mode TEXT NOT NULL,                        -- write | read
  PRIMARY KEY (sweep_id, resource, worker, mode)
);

-- Census: measured activity per member, so idle is separated from unmeasured.
CREATE TABLE IF NOT EXISTS graph_wiring_census (
  name TEXT PRIMARY KEY,
  in_roster INTEGER NOT NULL,
  first_measured_at TEXT,
  last_active_at TEXT,
  runs INTEGER, failures INTEGER, external_requests INTEGER, excluded_requests INTEGER,
  class TEXT NOT NULL,                       -- active | idle | failing | unmeasured
  action TEXT NOT NULL,                      -- keep | watch | extend_roster | retire_candidate
  checked_at TEXT NOT NULL
);
