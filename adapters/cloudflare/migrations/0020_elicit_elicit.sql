-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Needs register, assumption log, ignorance audit evidence and glossary (US-SPEC-16). Tables are prefixed elicit_.
CREATE TABLE IF NOT EXISTS elicit_needs (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  artifact TEXT NOT NULL,                    -- the REQUIRED artifact (US-SPEC-15) this need feeds
  must INTEGER NOT NULL DEFAULT 1,
  reversible INTEGER NOT NULL DEFAULT 1,
  identity_bound INTEGER NOT NULL DEFAULT 0,
  exposes_private INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  question TEXT NOT NULL,
  why TEXT NOT NULL,
  cue TEXT NOT NULL,
  options TEXT NOT NULL,                     -- JSON array of 2 to 4 strings
  default_value TEXT,
  default_consequence TEXT,
  free_text INTEGER NOT NULL DEFAULT 0,
  p_wrong REAL NOT NULL DEFAULT 0.5,
  rework REAL NOT NULL DEFAULT 1,
  dependents INTEGER NOT NULL DEFAULT 1,
  priority REAL NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'open',        -- open | derived | asked | answered | defaulted | gated
  value TEXT,
  provenance TEXT,                           -- stated | derived | researched | default
  source TEXT,                               -- where a derived value came from
  answer_text TEXT,                          -- the person's words, verbatim
  channel TEXT,
  answered_at TEXT,
  asked_at TEXT,
  expires_at TEXT,
  more_count INTEGER NOT NULL DEFAULT 0,
  revisit TEXT,
  PRIMARY KEY (project, id)
);
CREATE TABLE IF NOT EXISTS elicit_assumptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  need_id TEXT NOT NULL,
  value TEXT,
  reason TEXT NOT NULL,                      -- not_sure | timeout | low_priority
  revisit_trigger TEXT NOT NULL,
  created_at TEXT NOT NULL,
  superseded_at TEXT
);
CREATE TABLE IF NOT EXISTS elicit_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sweep TEXT NOT NULL,                       -- catalog | analogy | redteam | surprise
  finding TEXT NOT NULL,
  disposition TEXT NOT NULL,                 -- need | risk | lesson | dismissed | needs_professional
  evidence TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS elicit_glossary (
  term TEXT PRIMARY KEY,
  plain TEXT NOT NULL,
  person_term TEXT,
  created_at TEXT NOT NULL
);
