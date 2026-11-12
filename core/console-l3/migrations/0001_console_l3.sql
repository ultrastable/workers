-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Operator console L3 (US-SPEC-13): report cards with evidence, and proposed objective-function changes. Tables are prefixed l3_.
CREATE TABLE IF NOT EXISTS l3_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  rubric TEXT NOT NULL,
  limits TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS l3_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  dimension TEXT NOT NULL,
  score REAL NOT NULL,
  evidence TEXT NOT NULL,
  confidence TEXT NOT NULL,
  status TEXT NOT NULL,
  cause TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS l3_scores_dim ON l3_scores (name, dimension, id);
CREATE TABLE IF NOT EXISTS l3_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  at TEXT NOT NULL
);
