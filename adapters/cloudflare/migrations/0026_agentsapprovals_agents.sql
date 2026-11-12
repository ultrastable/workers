-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
CREATE TABLE IF NOT EXISTS agents_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS agents_messages_s ON agents_messages(session_id, id);
CREATE TABLE IF NOT EXISTS agents_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, agent TEXT NOT NULL, tool TEXT NOT NULL, args_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied | expired
  created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL, decided_by TEXT
);
CREATE INDEX IF NOT EXISTS agents_approvals_s ON agents_approvals(status, expires_ms);
