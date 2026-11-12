-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Bounce and complaint intake ledger (US-21-R13). Idempotent. Only a hash of the recipient is kept, never the address.
CREATE TABLE IF NOT EXISTS guard_bounces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  pack TEXT,
  channel TEXT NOT NULL,
  recipient_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('hard','soft','complaint','unsubscribe')),
  event_id TEXT,
  action TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS guard_bounces_event ON guard_bounces (channel, event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS guard_bounces_recent ON guard_bounces (channel, recipient_hash, kind, at);
