-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- First-run console key (US-SPEC-18 door console_key/generated-first-run). One row ever. Only the SHA-256 hash of the key is kept.
CREATE TABLE IF NOT EXISTS doors_first_run (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  key_hash TEXT,
  issued_at TEXT,
  expired_at TEXT
);
