-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Virtual staff (US-SPEC-02 R05..R11, US-SPEC-03 s4 operations, queue score, origination). Idempotent.
-- Apply after the seed and kernel migrations: operations read items, claims, kernel_item_meta, kernel_focus, kernel_metrics.

CREATE TABLE IF NOT EXISTS staff_personas (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,                       -- e.g. program-manager, portfolio-manager
  plane TEXT NOT NULL DEFAULT 'org',        -- the lane: a persona never reads or writes another plane
  program_id TEXT,                          -- the one program a program manager owns; null = across programs
  scope TEXT NOT NULL,
  charter TEXT,
  instruction_source TEXT NOT NULL,         -- a file or prompt reference
  authority TEXT NOT NULL,                  -- JSON array: the enumerated operations (US-02-R05)
  filled_by TEXT NOT NULL DEFAULT 'agent' CHECK (filled_by IN ('agent','person')),  -- US-02-R11
  holder TEXT,                              -- agent or person handle
  tick_every INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

-- Which plane a program belongs to. A program with no row is in plane 'org'.
CREATE TABLE IF NOT EXISTS staff_planes (
  program_id TEXT PRIMARY KEY,
  plane TEXT NOT NULL
);

-- Stores (tables) that belong to one plane; the tool layer refuses them to a persona of another plane.
CREATE TABLE IF NOT EXISTS staff_plane_stores (
  store TEXT PRIMARY KEY,
  plane TEXT NOT NULL
);

-- US-02-R06: one row per operation, with the from and to value and evidence. A reversal is another row.
CREATE TABLE IF NOT EXISTS staff_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id TEXT NOT NULL,
  op TEXT NOT NULL,
  item_id TEXT,
  field TEXT,                               -- priority | status | doer | allocation | item
  from_value TEXT,
  to_value TEXT,
  evidence TEXT NOT NULL,
  tick_id INTEGER,
  reverses INTEGER,                         -- the action this row reverses
  reversed_by INTEGER,                      -- the action that reversed this row
  decision_id TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staff_actions ON staff_actions(persona_id, tick_id);
CREATE INDEX IF NOT EXISTS idx_staff_actions_item ON staff_actions(item_id, id);

-- Refused operations and reads: 'authority' (not on the list), 'lane' (other plane or program), 'control_plane', 'precondition'.
CREATE TABLE IF NOT EXISTS staff_denials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id TEXT NOT NULL,
  op TEXT NOT NULL,
  target TEXT,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  tick_id INTEGER,
  at TEXT NOT NULL
);

-- US-02-R07: one brief per persona per tick it runs.
CREATE TABLE IF NOT EXISTS staff_briefs (
  persona_id TEXT NOT NULL,
  tick_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  actions INTEGER NOT NULL,
  denials INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (persona_id, tick_id)
);

-- Queue score rows carry their writer (US-01-R07): a persona replaces and deletes only its own rows.
CREATE TABLE IF NOT EXISTS staff_priority_scores (
  item_id TEXT NOT NULL,
  writer TEXT NOT NULL,
  impact REAL NOT NULL, probability REAL NOT NULL,
  capability_gain REAL NOT NULL, reach_gain REAL NOT NULL,
  remediation_cost REAL NOT NULL, trust REAL NOT NULL, direction REAL NOT NULL,
  score REAL NOT NULL,
  focused INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL,
  PRIMARY KEY (item_id, writer)
);

-- One row per origination attempt (accepted or not), so a program is asked once a day and the daily cap is countable.
CREATE TABLE IF NOT EXISTS staff_originations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  day TEXT NOT NULL,                        -- YYYY-MM-DD
  title TEXT, why TEXT, code_task TEXT, code_anchor TEXT, edit TEXT,
  item_id TEXT,                             -- null = not filed
  reason TEXT,
  at TEXT NOT NULL,
  UNIQUE (program_id, day)
);
