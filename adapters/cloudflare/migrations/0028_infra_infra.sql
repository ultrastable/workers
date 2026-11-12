-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
CREATE TABLE IF NOT EXISTS infra_heartbeats (name TEXT PRIMARY KEY, last_ms INTEGER NOT NULL, beats INTEGER NOT NULL DEFAULT 1, every_minutes INTEGER);
CREATE TABLE IF NOT EXISTS infra_rate (key TEXT NOT NULL, window_ms INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (key, window_ms));
