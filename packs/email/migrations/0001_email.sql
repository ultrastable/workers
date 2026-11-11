-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Email pack (US-SPEC-21). Idempotent. The address is kept only while it may still be mailed; it is cleared on unsubscribe or bounce.
CREATE TABLE IF NOT EXISTS email_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_hash TEXT NOT NULL UNIQUE,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','unsubscribed','bounced')),
  source TEXT,
  created_at TEXT NOT NULL,
  confirm_sent_at TEXT,
  confirmed_at TEXT,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS email_subscribers_status ON email_subscribers (status, id);
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  subscriber_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS email_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'newsletter',
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','done','cancelled')),
  created_at TEXT NOT NULL,
  done_at TEXT
);
CREATE TABLE IF NOT EXISTS email_deliveries (
  message_id INTEGER NOT NULL,
  subscriber_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','queued','skipped','failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  reason TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (message_id, subscriber_id)
);
CREATE TABLE IF NOT EXISTS email_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_hash TEXT NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS email_metrics (
  at TEXT PRIMARY KEY,
  confirmed INTEGER NOT NULL,
  pending INTEGER NOT NULL,
  unsubscribed INTEGER NOT NULL,
  bounced INTEGER NOT NULL
);
