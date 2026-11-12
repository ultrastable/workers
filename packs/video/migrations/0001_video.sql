-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Video pack tables (US-SPEC-21 class B). Idempotent. No credential is ever stored here (US-21-R09).

CREATE TABLE IF NOT EXISTS video_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idem_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  duration_s INTEGER NOT NULL,
  asset_ref TEXT NOT NULL,                       -- storage key of the file, never a URL carrying a credential
  asset_sha256 TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  provenance_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','awaiting_approval','published','refused','removed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  guard_reason TEXT,
  guard_queue_id INTEGER,
  card_id TEXT,
  provider_id TEXT,
  url TEXT,
  views INTEGER,
  views_at TEXT,
  verify_status TEXT CHECK (verify_status IN ('verified','failed')),
  verify_attempts INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  removed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_video_queue_status ON video_queue(status, id);

CREATE TABLE IF NOT EXISTS video_rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  title TEXT NOT NULL,
  violations TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS video_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  published INTEGER NOT NULL,
  verified INTEGER NOT NULL,
  removed INTEGER NOT NULL,
  refused INTEGER NOT NULL,
  views INTEGER NOT NULL
);
