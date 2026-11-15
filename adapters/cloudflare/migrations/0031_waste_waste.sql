-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
CREATE TABLE IF NOT EXISTS waste_gauge_findings (
  key TEXT PRIMARY KEY, rule TEXT NOT NULL, gauge TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  clean_runs INTEGER NOT NULL DEFAULT 0, value REAL, item_id TEXT, status TEXT NOT NULL DEFAULT 'open'
);
