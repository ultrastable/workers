-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Yield and waste module: metered model calls per day, findings with a lifecycle, run history. Idempotent.
CREATE TABLE IF NOT EXISTS yield_calls (
  day TEXT NOT NULL, source TEXT NOT NULL, purpose TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
  out_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, purpose)
);
CREATE TABLE IF NOT EXISTS yield_findings (
  key TEXT PRIMARY KEY, rule TEXT NOT NULL, source TEXT, purpose TEXT,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, clean_runs INTEGER NOT NULL DEFAULT 0,
  metric REAL, cost REAL, evidence TEXT, item_id TEXT, status TEXT NOT NULL DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS yield_runs (
  ts TEXT PRIMARY KEY, wasted_cost REAL, total_cost REAL, outputs INTEGER, cost_per_output REAL,
  findings_open INTEGER, items_filed INTEGER, items_closed INTEGER, error TEXT
);
