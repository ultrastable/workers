-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
CREATE TABLE IF NOT EXISTS runner_ownerwatch (
  card_id TEXT PRIMARY KEY, first_seen_ms INTEGER NOT NULL, last_probe_ms INTEGER, probes INTEGER NOT NULL DEFAULT 0, escalated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS runner_probe_cadence (
  name TEXT PRIMARY KEY, last_run_ms INTEGER, last_ok INTEGER, fail_streak INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0
);
