-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Social pack tables (US-SPEC-21 class B). Idempotent. No credential is ever stored here (US-21-R09).

CREATE TABLE IF NOT EXISTS social_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idem_key TEXT NOT NULL UNIQUE,                 -- one post per key, whatever the retries
  text TEXT NOT NULL,
  claim_ids TEXT NOT NULL,                       -- JSON array of claim ids the text rests on
  reply_to TEXT,                                 -- provider id of the parent post (threads), optional
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','awaiting_approval','published','refused','removed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  guard_reason TEXT,
  guard_queue_id INTEGER,
  card_id TEXT,
  provider_id TEXT,
  url TEXT,
  predicted_engagement REAL,
  engagement INTEGER,
  engagement_at TEXT,
  engagement_verdict TEXT,                       -- hit | miss | null until scored
  verify_status TEXT CHECK (verify_status IN ('verified','failed')),
  verify_attempts INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  removed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_social_queue_status ON social_queue(status, id);

CREATE TABLE IF NOT EXISTS social_rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  text TEXT NOT NULL,
  violations TEXT NOT NULL                       -- JSON array
);

CREATE TABLE IF NOT EXISTS social_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  published INTEGER NOT NULL,
  verified INTEGER NOT NULL,
  removed INTEGER NOT NULL,
  refused INTEGER NOT NULL,
  engagement INTEGER NOT NULL
);
