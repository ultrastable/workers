-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Claims module (US-SPEC-08): path/item claims, deploy lock, secret lease. Idempotent. Tokens are stored only as SHA-256 hashes.

CREATE TABLE IF NOT EXISTS claims_lock (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- work | deploy | secret
  key TEXT NOT NULL,               -- item:<id> | path:<path> | any caller key; secret: the secret NAME only
  holder TEXT NOT NULL,
  intent TEXT NOT NULL DEFAULT '',
  intent_norm TEXT NOT NULL DEFAULT '',
  item_id TEXT,
  token_hash TEXT NOT NULL,
  fence INTEGER NOT NULL,
  ttl_minutes REAL NOT NULL,
  claimed_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  outcome TEXT
);
-- At most one live claim per (kind, key): enforced by the store, so a race has exactly one winner.
CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_lock_live ON claims_lock(kind, key) WHERE released_at IS NULL;
-- Fences are unique and increase per (kind, key); rows are never deleted.
CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_lock_fence ON claims_lock(kind, key, fence);
CREATE INDEX IF NOT EXISTS idx_claims_lock_expiry ON claims_lock(released_at, expires_at);

CREATE TABLE IF NOT EXISTS claims_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT,
  key TEXT,
  holder TEXT,
  event TEXT NOT NULL,             -- acquired | refused | renewed | released | expired | terminal | gate | kill-switch
  detail TEXT                      -- never contains a token
);

CREATE TABLE IF NOT EXISTS claims_pulls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  puller TEXT NOT NULL,
  item_id TEXT,
  route TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claims_loop_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  loop TEXT NOT NULL,
  scanned INTEGER NOT NULL,
  executed INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  needs_human INTEGER NOT NULL,
  no_action INTEGER NOT NULL,
  gap INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS claims_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,              -- accounting_gap | rework_escalation
  ref TEXT,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS claims_rework (
  item_id TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  escalated_at TEXT
);

CREATE TABLE IF NOT EXISTS claims_idem (
  op TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  response TEXT NOT NULL,          -- token field removed before storing
  at TEXT NOT NULL,
  PRIMARY KEY (op, idem_key)
);
