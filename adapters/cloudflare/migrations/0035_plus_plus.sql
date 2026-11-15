-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Plus loop (US-SPEC-04 s5). Idempotent. Reads and writes the seed tables items and gate_cards only.
-- The spec's product_registry is plus_product_registry here (module prefix); plus_ledger keeps its name.

CREATE TABLE IF NOT EXISTS plus_product_registry (
  product TEXT PRIMARY KEY,
  host TEXT,
  program TEXT,
  usage_metric TEXT NOT NULL,               -- the outcome measure
  usage_value REAL,                         -- null = unmeasured, never 0 (US-04-R09)
  usage_window TEXT,
  usage_read_at TEXT,
  usage_label TEXT,                         -- says when machine requests are counted with human ones (US-04-R14)
  quality_measure TEXT NOT NULL,            -- the guard measure; differs from usage_metric (US-04-R08)
  quality_direction TEXT NOT NULL DEFAULT 'lower' CHECK (quality_direction IN ('lower','higher')),  -- which way is better
  plus_cadence_h REAL NOT NULL DEFAULT 24,
  last_plus_at TEXT,
  rest_until TEXT,
  misses_in_row INTEGER NOT NULL DEFAULT 0,
  pluses_since_simplify INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plus_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('plus','measurement','simplify','revert')),
  title TEXT NOT NULL,
  evidence TEXT,
  predicted_outcome TEXT,                   -- '<metric> up|down <pct>% within <N> h', stated before the plus is made
  metric TEXT,
  direction TEXT, size REAL, min_gain REAL,
  guard TEXT,
  angle TEXT,
  doer TEXT,
  revert_path TEXT,
  issue_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed','filed','shipped','kept','reverted')),
  baseline REAL, guard_baseline REAL,       -- stored at verified deployment
  outcome REAL, guard_outcome REAL,         -- null = unmeasured
  verdict TEXT,                             -- kept | missed | guard_worse | unmeasured
  prediction_hit INTEGER,
  seeded_from INTEGER,
  window_h REAL,
  created_at TEXT NOT NULL,
  shipped_at TEXT, due_at TEXT, decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_plus_ledger ON plus_ledger(product, status);

CREATE TABLE IF NOT EXISTS plus_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,
  measure TEXT NOT NULL,
  value REAL,                               -- null = the read failed (unmeasured)
  window_label TEXT,
  label TEXT,
  evidence TEXT,
  read_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plus_readings ON plus_readings(product, measure, id);

-- US-04-R05: the reserved share is lowered only by a row here, and only until the row expires.
CREATE TABLE IF NOT EXISTS plus_share_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share REAL NOT NULL,
  reason TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plus_digest (
  week TEXT NOT NULL,                       -- the Monday (UTC) that starts the week
  product TEXT NOT NULL,
  shipped INTEGER NOT NULL, kept INTEGER NOT NULL, reverted INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (week, product)
);
