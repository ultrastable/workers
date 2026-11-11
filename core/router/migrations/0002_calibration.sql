-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
CREATE TABLE IF NOT EXISTS router_calibration (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, provider TEXT NOT NULL, rung TEXT NOT NULL,
  probe TEXT NOT NULL, ok INTEGER NOT NULL, latency_ms INTEGER, detail TEXT
);
CREATE INDEX IF NOT EXISTS router_calibration_p ON router_calibration(provider, rung, id);
