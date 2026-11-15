-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Self-amending governance (US-SPEC-07 section 3): signature register, hits, stored scans, amendment proposals, lineage,
-- objective space. Idempotent. Table names carry the module prefix; the spec's false_stop_* tables are governance_false_stop_*.
-- Reads the seed tables claims, items, tick_runs; writes governance_* tables, work items and doctrine_lineage rows.

CREATE TABLE IF NOT EXISTS governance_false_stop_register (
  pattern_key TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,                    -- the shape, in words
  cause_class TEXT NOT NULL,
  detection_heuristic TEXT NOT NULL,        -- phrase | classifier | state
  auto_remediation TEXT NOT NULL,           -- the redirect
  requires_action INTEGER NOT NULL DEFAULT 0,
  trust_event TEXT,                         -- event name of the deduction, null = none
  weight REAL NOT NULL DEFAULT 0,           -- signed trust weight per hit
  commitment TEXT,                          -- the commitment this signature enforces, if any
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS governance_false_stop_phrases (
  pattern_key TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '*',          -- '*' or the kind of text: report, principal, ...
  phrase TEXT NOT NULL,                     -- plain text (case-insensitive) or 're:<regular expression>'
  PRIMARY KEY (pattern_key, scope, phrase)
);

-- Every text the engine looked at, kept so an amendment can be replayed against it.
CREATE TABLE IF NOT EXISTS governance_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  scope TEXT NOT NULL,
  tick_id INTEGER,
  draft TEXT NOT NULL,
  label INTEGER                             -- 1 confirmed false stop, 0 confirmed not one, null unjudged
);
CREATE INDEX IF NOT EXISTS idx_governance_scans_ts ON governance_scans(ts);

CREATE TABLE IF NOT EXISTS governance_false_stop_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  pattern_key TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  excerpt TEXT,
  excluded INTEGER NOT NULL DEFAULT 0,
  exclusion_reason TEXT,
  scan_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_governance_hits ON governance_false_stop_hits(pattern_key, source, ts);

CREATE TABLE IF NOT EXISTS governance_deductions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  surface TEXT NOT NULL,
  action_class TEXT NOT NULL,
  executor TEXT,
  pattern_key TEXT NOT NULL,
  event TEXT NOT NULL,
  weight REAL NOT NULL,
  hit_id INTEGER
);

CREATE TABLE IF NOT EXISTS governance_proposals (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  origin TEXT NOT NULL,                     -- threshold | friction | manual
  pattern_key TEXT,
  source TEXT,
  evidence TEXT,                            -- JSON: the hits that raised it
  rule_text TEXT,
  changes TEXT,                             -- JSON array of structured changes
  author TEXT,
  author_family TEXT,
  status TEXT NOT NULL DEFAULT 'collected', -- collected | generated | redteamed | replayed | adopted | rejected
  redteam TEXT,                             -- JSON: family, result
  replay TEXT,                              -- JSON: before, after, window
  reason TEXT,
  version TEXT,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS governance_lineage (
  version TEXT PRIMARY KEY,
  parent_version TEXT,
  proposal_id TEXT,
  register_hash TEXT NOT NULL,
  commitments_hash TEXT NOT NULL,
  adopted_by TEXT,
  adopted_at TEXT NOT NULL
);

-- Objective space (US-SPEC-07 section 3.2).
CREATE TABLE IF NOT EXISTS governance_objectives (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  status TEXT NOT NULL,                     -- ratified | proposed | rejected
  author TEXT NOT NULL,
  ratified_by TEXT,
  revises TEXT,                             -- objective id this row would revise
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS governance_goals (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  definition_of_done TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- derived | novel
  status TEXT NOT NULL,                     -- adopted | probation | retired
  parent_objective TEXT,
  alignment TEXT,
  score REAL NOT NULL,
  probation_until TEXT,
  dispatchable INTEGER NOT NULL DEFAULT 0,  -- 0: not handed to executors with write authority
  author TEXT,
  done_probe TEXT,
  adopted_at TEXT NOT NULL,
  retired_at TEXT,
  retire_reason TEXT
);

-- Adoption writes a row here that a worker drains, so a goal is never inert.
CREATE TABLE IF NOT EXISTS governance_goal_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  drained_at TEXT,
  item_id TEXT
);
