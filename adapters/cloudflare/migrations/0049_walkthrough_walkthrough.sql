-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- First-run walkthrough and per-person profile (US-SPEC-18 sections 5 and 6). Tables are prefixed walkthrough_.
CREATE TABLE IF NOT EXISTS walkthrough_state (
  person TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  idea_text TEXT,                            -- the person's own words, verbatim (A-INI-1)
  idea_at TEXT,
  readback_shown_at TEXT,
  readback_confirmed_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS walkthrough_profiles (
  person TEXT PRIMARY KEY,
  detail TEXT NOT NULL DEFAULT 'brief',      -- brief | more
  language TEXT NOT NULL DEFAULT 'en',
  cadence_minutes INTEGER NOT NULL DEFAULT 60,
  metrics TEXT NOT NULL DEFAULT '["open","done","stuck"]',   -- JSON, at most three
  extra_cards TEXT NOT NULL DEFAULT '[]',    -- JSON: cards a program defines
  source TEXT NOT NULL DEFAULT 'default',    -- default | walkthrough | person
  updated_at TEXT NOT NULL
);
