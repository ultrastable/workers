-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Cloud pack tables (US-SPEC-21 class D). Idempotent. Artifacts are never stored, only their digest; no credential is stored.

CREATE TABLE IF NOT EXISTS cloud_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idem_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  unit TEXT NOT NULL,
  version TEXT NOT NULL,
  expected_version TEXT,
  artifact_sha256 TEXT,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','awaiting_approval','deployed','reverted','failed','refused')),
  attempts INTEGER NOT NULL DEFAULT 0,
  guard_reason TEXT,
  guard_queue_id INTEGER,
  card_id TEXT,
  ledger_id INTEGER,                             -- id in deploy_ledger (core/deploy)
  detail TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cloud_requests_status ON cloud_requests(status, id);

CREATE TABLE IF NOT EXISTS cloud_units (
  provider TEXT NOT NULL,
  unit TEXT NOT NULL,
  live_version TEXT,
  consistent INTEGER NOT NULL DEFAULT 1,
  detail TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (provider, unit)
);

CREATE TABLE IF NOT EXISTS cloud_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  deployed INTEGER NOT NULL,
  reverted INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  unlogged INTEGER NOT NULL
);
