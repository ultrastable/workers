-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Signal pipeline (US-SPEC-12 Part A): signals, boundary, incidents, artifacts, revisions, fitness experiments. Idempotent.

CREATE TABLE IF NOT EXISTS signals_signals (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  content TEXT NOT NULL,
  open_questions TEXT,                       -- JSON list (re-entry signals carry U(a))
  evidential_weight REAL,                    -- null = noise (US-12-R01)
  domain TEXT,
  status TEXT NOT NULL,                      -- proposed | triaged | logged | noise
  decision TEXT,                             -- ACCEPT | LOG | IGNORE
  score REAL,
  triage_method TEXT,                        -- scorecard | fitness
  created_at TEXT NOT NULL
);
-- Re-entry is idempotent on the artifact identifier (US-12-R04).
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_reentry ON signals_signals(source_ref) WHERE source = 'artifact_reentry';
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals_signals(status, ts);

-- Default deny: no row means no access (US-12-R02).
CREATE TABLE IF NOT EXISTS signals_boundary (
  worker TEXT NOT NULL,
  source TEXT NOT NULL,
  permitted INTEGER NOT NULL DEFAULT 1,
  domain TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (worker, source)
);

CREATE TABLE IF NOT EXISTS signals_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- boundary_denial | narrowing | unstored_weight
  worker TEXT, source TEXT, domain TEXT,
  ref TEXT,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS signals_artifacts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  abstract TEXT,
  content TEXT NOT NULL,
  assertions TEXT NOT NULL DEFAULT '[]',     -- JSON list of result-asserting statements the content carries
  source_signals TEXT NOT NULL DEFAULT '[]',
  made_by TEXT,
  open_questions TEXT,                       -- JSON list U(a); null = not recorded
  state TEXT NOT NULL DEFAULT 'candidate',   -- candidate | audited | deposited | published | distributed
  attribution TEXT,
  deposit_id TEXT UNIQUE,
  review TEXT,                               -- verified | clean | failed
  reentry_weight REAL,                       -- stored at deposit, never inferred (US-12-R06)
  created_at TEXT NOT NULL,
  deposited_at TEXT
);

CREATE TABLE IF NOT EXISTS signals_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id TEXT NOT NULL,
  at TEXT NOT NULL,
  before_count INTEGER NOT NULL,
  after_count INTEGER NOT NULL,
  accepted INTEGER NOT NULL,
  reason TEXT NOT NULL,                      -- strict_shrink | no_shrink | narrowing | not_audited
  detail TEXT
);

-- The fitness threshold is one row whose value starts null; a number is written only with a winning experiment (US-12-R08).
CREATE TABLE IF NOT EXISTS signals_fitness (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  threshold REAL,
  experiment_id INTEGER,
  set_at TEXT
);
INSERT OR IGNORE INTO signals_fitness (id, threshold) VALUES (1, NULL);

CREATE TABLE IF NOT EXISTS signals_experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  n INTEGER NOT NULL,
  fitness_yield REAL NOT NULL,               -- open questions closed per unit of effort under fitness-scored triage
  recency_yield REAL NOT NULL,               -- the same under recency-scored triage
  proposed_threshold REAL NOT NULL,
  adopted INTEGER NOT NULL,
  reason TEXT NOT NULL
);
