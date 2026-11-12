-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Ledger of the migrations the pack host applied for each pack on enable (US-SPEC-21, US-21-R08). Idempotent.
CREATE TABLE IF NOT EXISTS packs_migrations (
  pack_id TEXT NOT NULL,
  file TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  statements INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (pack_id, file)
);
