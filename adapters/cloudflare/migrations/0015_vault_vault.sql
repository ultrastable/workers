-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Secrets a person pastes once into the console (US-SPEC-18 doors). Presence is readable; values are not.
CREATE TABLE IF NOT EXISTS vault_secrets (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  set_by TEXT NOT NULL DEFAULT 'console',
  set_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
