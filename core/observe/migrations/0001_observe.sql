-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
CREATE TABLE IF NOT EXISTS observe_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, source TEXT NOT NULL, route TEXT, status INTEGER, duration_ms INTEGER, outcome TEXT NOT NULL, detail TEXT
);
CREATE INDEX IF NOT EXISTS observe_events_source_at ON observe_events (source, at);
