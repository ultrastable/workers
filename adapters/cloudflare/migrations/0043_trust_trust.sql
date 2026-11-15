-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Trust ledger extensions and the interrupt gate (US-SPEC-06). Idempotent. Reads the seed tables outcomes, trust_ledger,
-- claims, tick_runs, items, gate_cards; writes trust_* tables, ladder items, gate cards, and the ledger rung only through
-- applyRungChange (a merged, reviewed change).

-- One row per (surface, action class, executor). executor = '' is the pair itself.
CREATE TABLE IF NOT EXISTS trust_scores (
  surface TEXT NOT NULL,
  action_class TEXT NOT NULL,
  executor TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL,
  n INTEGER NOT NULL,
  severe INTEGER NOT NULL,                  -- severe outcomes inside the stated window
  reliability REAL NOT NULL,                -- (ok + b*w) / (n + w)
  event_adjust REAL NOT NULL DEFAULT 0,     -- sum of event weights
  idle_units REAL NOT NULL DEFAULT 0,       -- unexercised ticks or days
  score REAL NOT NULL,                      -- reliability + events, decayed toward the prior, clamped to [0, 1]
  lower_bound REAL,                         -- Wilson lower bound of ok/n, null without outcomes
  indicated_rung TEXT,                      -- where the rule points; the rung itself is never changed here
  last_exercised_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (surface, action_class, executor)
);

CREATE TABLE IF NOT EXISTS trust_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  surface TEXT NOT NULL,
  action_class TEXT NOT NULL,
  executor TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL,
  weight REAL NOT NULL,
  ref TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trust_events_pair ON trust_events(surface, action_class, executor);

-- Rungs of executors (the pair's rung stays in the seed trust_ledger).
CREATE TABLE IF NOT EXISTS trust_executor_rungs (
  surface TEXT NOT NULL,
  action_class TEXT NOT NULL,
  executor TEXT NOT NULL,
  rung TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (surface, action_class, executor)
);

-- Every ladder transition, indicated or applied, with its evidence (US-06-R17).
CREATE TABLE IF NOT EXISTS trust_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  surface TEXT NOT NULL,
  action_class TEXT NOT NULL,
  executor TEXT NOT NULL DEFAULT '',
  from_rung TEXT NOT NULL,
  to_rung TEXT NOT NULL,
  direction TEXT NOT NULL,                  -- promote | demote
  status TEXT NOT NULL,                     -- proposed | applied | refused
  evidence TEXT NOT NULL,                   -- JSON: reliability, n, severe, window, formula
  item_id TEXT,
  opened_by TEXT,
  merged_by TEXT,
  reason TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trust_transitions_pair ON trust_transitions(surface, action_class, executor, id);

-- What the gate knows about a seed gate card.
CREATE TABLE IF NOT EXISTS trust_gate_meta (
  card_id TEXT PRIMARY KEY,
  surface TEXT,
  action_class TEXT,
  identity_bound_line TEXT,                 -- why only the principal can take this step; empty = must be rerouted
  priority INTEGER NOT NULL DEFAULT 50,
  opened_by TEXT,
  opened_at TEXT NOT NULL,
  rerouted_to TEXT,
  rerouted_at TEXT
);

-- Reversibility engineering attempts made before an action is classified irreversible (US-06-R14).
CREATE TABLE IF NOT EXISTS trust_reversibility_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_ref TEXT NOT NULL,
  form TEXT NOT NULL,                       -- backup | flag | canary | draft | split | ...
  ok INTEGER NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);

-- Refusals by standing limits and checks. A refusal is an input (US-SPEC-06 s4, US-07-R08).
CREATE TABLE IF NOT EXISTS trust_refusals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,                -- surface, action class and target: independent of the wording
  condition_hash TEXT NOT NULL,             -- the state the check refused; a changed condition may try once more
  reason TEXT NOT NULL,
  executor TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trust_refusals_fp ON trust_refusals(check_name, fingerprint);

-- Self-adoption: a reversible, in-scope question answered by executing the recommended default (US-06-R16).
CREATE TABLE IF NOT EXISTS trust_adoptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  default_taken TEXT NOT NULL,
  revert_path TEXT NOT NULL,
  surface TEXT,
  action_class TEXT,
  executor TEXT,
  verified INTEGER NOT NULL,
  evidence TEXT,
  at TEXT NOT NULL
);
