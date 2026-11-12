-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
CREATE TABLE IF NOT EXISTS tasks_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload_json TEXT, status TEXT NOT NULL DEFAULT 'pending', -- pending|done|failed
  attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, handler TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_queue_due ON tasks_queue(status, next_at);
CREATE TABLE IF NOT EXISTS tasks_owner_steps (card_id TEXT PRIMARY KEY, first_seen_ms INTEGER NOT NULL);
