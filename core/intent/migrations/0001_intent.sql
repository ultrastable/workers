-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
CREATE TABLE IF NOT EXISTS intent_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client TEXT NOT NULL, text TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
  verdict TEXT NOT NULL, item_id TEXT, reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
