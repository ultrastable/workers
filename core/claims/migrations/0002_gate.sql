-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Claims module (US-SPEC-08 s5, s6): parent links, closure blocks from accounting gaps, visibility ratio, principal-queue lines. Idempotent.

CREATE TABLE IF NOT EXISTS claims_parents (
  item_id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_parents_parent ON claims_parents(parent_id);

-- A parent cannot close while one of its children is unaccounted by a loop run.
CREATE TABLE IF NOT EXISTS claims_closure_blocks (
  parent_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  incident_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  cleared_at TEXT,
  PRIMARY KEY (parent_id, child_id, incident_id)
);

CREATE TABLE IF NOT EXISTS claims_visibility (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  open_all INTEGER NOT NULL,
  open_visible INTEGER NOT NULL,
  ratio REAL,                                -- null when nothing is visible
  threshold REAL NOT NULL,
  fired INTEGER NOT NULL,
  stores TEXT NOT NULL                       -- JSON [{name, visible, open, error?}]
);

-- The identity-bound line of a gate card, and the item the card holds.
CREATE TABLE IF NOT EXISTS claims_gate_lines (
  card_id TEXT PRIMARY KEY,
  item_id TEXT,
  identity_bound_line TEXT
);
