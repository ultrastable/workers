-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Router tables (US-SPEC-09). Idempotent.
CREATE TABLE IF NOT EXISTS router_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  role TEXT,
  item_id TEXT,
  kind TEXT,                    -- doer | reviewer | other
  rung_requested TEXT,
  rung_used TEXT,
  provider TEXT,
  model TEXT,
  family TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,        -- ok | error | refused
  error TEXT,
  steered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS router_calls_at ON router_calls(at);
CREATE INDEX IF NOT EXISTS router_calls_item ON router_calls(item_id, kind);

CREATE TABLE IF NOT EXISTS router_switches (
  name TEXT PRIMARY KEY,              -- 'all' or 'provider:<name>'
  is_on INTEGER NOT NULL DEFAULT 1,   -- 1 = kill switch engaged
  reason TEXT,
  set_at TEXT
);

CREATE TABLE IF NOT EXISTS router_gate_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  what TEXT NOT NULL,
  why_gated TEXT NOT NULL,
  default_in_effect TEXT NOT NULL,
  closing_probe TEXT NOT NULL,
  scope TEXT,
  status TEXT NOT NULL DEFAULT 'open'
);
