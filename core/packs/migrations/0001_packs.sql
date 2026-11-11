-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Capability packs and the outbound guard (US-SPEC-21). Idempotent. Recipients and content are stored as hashes in the ledger;
-- guard_queue holds the raw recipient and content only while a person has not decided, and clears them on decision.

CREATE TABLE IF NOT EXISTS packs_registry (
  id TEXT PRIMARY KEY,
  class TEXT NOT NULL CHECK (class IN ('A','B','C','D')),
  manifest_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  source_dir TEXT,
  rung_ceiling TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  enabled_by TEXT,
  enabled_at TEXT,
  card_text_shown TEXT,
  decision_id TEXT,
  disabled_at TEXT,
  registered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS packs_switches (
  scope TEXT PRIMARY KEY,               -- global | pack:<id> | channel:<name>
  is_on INTEGER NOT NULL DEFAULT 1,     -- 1 = kill switch engaged
  reason TEXT,
  set_at TEXT
);

CREATE TABLE IF NOT EXISTS packs_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pack_id TEXT NOT NULL,
  loop_id TEXT NOT NULL,
  tick_id INTEGER,
  outcome TEXT NOT NULL,                -- ok | error | timeout | skipped_killed
  error TEXT,
  ms INTEGER,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_packs_runs ON packs_runs(pack_id, loop_id, id);

CREATE TABLE IF NOT EXISTS guard_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  pack TEXT NOT NULL,
  channel TEXT NOT NULL,
  kind TEXT,
  recipient_hash TEXT,
  content_hash TEXT,
  idem_key TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('sent','queued_for_approval','refused')),
  reason TEXT,
  provider_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_guard_ledger_caps ON guard_ledger(pack, channel, decision, at);
CREATE INDEX IF NOT EXISTS idx_guard_ledger_idem ON guard_ledger(pack, idem_key);

CREATE TABLE IF NOT EXISTS guard_suppression (
  recipient_hash TEXT NOT NULL,
  channel TEXT NOT NULL,                -- a channel name, or * for every channel
  reason TEXT NOT NULL,                 -- unsubscribe | bounce | complaint | manual
  at TEXT NOT NULL,
  PRIMARY KEY (recipient_hash, channel)
);

CREATE TABLE IF NOT EXISTS guard_consent (
  recipient_hash TEXT NOT NULL,
  channel TEXT NOT NULL,
  pack TEXT NOT NULL DEFAULT '*',       -- the pack the person consented to hear from, or * for any pack
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','revoked')),
  token_hash TEXT,
  requested_at TEXT NOT NULL,
  confirmed_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY (recipient_hash, channel, pack)
);

CREATE TABLE IF NOT EXISTS guard_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  pack TEXT NOT NULL,
  channel TEXT NOT NULL,
  kind TEXT,
  recipient_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  idem_key TEXT,
  recipient TEXT,                       -- cleared once decided
  content TEXT,                         -- cleared once decided
  card_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | refused | rejected
  decided_by TEXT,
  decided_at TEXT,
  reason TEXT
);
