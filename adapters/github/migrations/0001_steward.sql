-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
CREATE TABLE IF NOT EXISTS steward_mirror (item_id TEXT NOT NULL, sink TEXT NOT NULL, ref TEXT, hash TEXT NOT NULL, synced_at TEXT NOT NULL, last_error TEXT, PRIMARY KEY (item_id, sink));
