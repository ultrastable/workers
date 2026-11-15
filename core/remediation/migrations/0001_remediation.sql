-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Remediation module (US-SPEC-17): detector hits outside the kernel register, sightings, item ledger, ledger cursors. Idempotent.
-- The failure-mode register, remediation contracts and the breaker live in core/kernel (tables kernel_*); this module reads them.

-- One row per run of a detector hosted here, fired or not (US-17-R01).
CREATE TABLE IF NOT EXISTS remediation_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  detector TEXT NOT NULL,
  host TEXT,
  ts TEXT NOT NULL,
  value REAL, expected REAL,
  fired INTEGER NOT NULL,
  evidence TEXT
);
CREATE INDEX IF NOT EXISTS idx_remediation_hits ON remediation_hits(detector, id);

-- A failure seen without a detector; the second sighting registers one (US-17-R03).
CREATE TABLE IF NOT EXISTS remediation_sightings (
  signature TEXT PRIMARY KEY,
  surface TEXT,
  count INTEGER NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  fm_id TEXT
);
CREATE TABLE IF NOT EXISTS remediation_sighting_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT NOT NULL,
  at TEXT NOT NULL,
  detail TEXT
);

-- Every item that ever entered, so one that vanished is found: entered = open + closed + superseded.
CREATE TABLE IF NOT EXISTS remediation_item_ledger (
  item_id TEXT PRIMARY KEY,
  entered_at TEXT NOT NULL,
  title TEXT NOT NULL, kind TEXT NOT NULL, owner_role TEXT NOT NULL, done_check TEXT NOT NULL, closing_probe TEXT, priority INTEGER NOT NULL,
  restored INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS remediation_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- loops | items | roster
  balanced INTEGER NOT NULL,
  detail TEXT NOT NULL
);

-- Position in an external attempt ledger already fed to the loop breaker.
CREATE TABLE IF NOT EXISTS remediation_cursors (
  ledger TEXT PRIMARY KEY,
  cursor TEXT NOT NULL
);
