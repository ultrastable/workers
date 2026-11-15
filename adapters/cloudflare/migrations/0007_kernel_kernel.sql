-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- L2 kernel schema (US-SPEC-03 s4, 04, 05, 17). Idempotent. Items of a program carry items.project = program id
-- (or the id of a kernel project that belongs to the program).

CREATE TABLE IF NOT EXISTS kernel_programs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  objective TEXT,
  primary_metric_id TEXT,
  cost_cap REAL,
  owner_role TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kernel_metrics (
  id TEXT PRIMARY KEY,
  program_id TEXT,
  kind TEXT NOT NULL DEFAULT 'target' CHECK (kind IN ('target','guard')),
  op TEXT NOT NULL CHECK (op IN ('>=','<=','>','<','=')),
  target REAL NOT NULL,
  read_probe TEXT NOT NULL,                -- one SELECT returning a column named value
  max_age_h REAL NOT NULL DEFAULT 24,      -- an older reading is unmeasured, never a pass
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kernel_metric_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_id TEXT NOT NULL,
  value REAL,                              -- null = the probe failed or returned nothing (unmeasured)
  read_at TEXT NOT NULL,
  evidence TEXT
);
CREATE INDEX IF NOT EXISTS idx_kernel_readings ON kernel_metric_readings(metric_id, id);

-- The verdict is computed here, never stored. hit = 1 is a breach. The clock is read in the same statement as the data.
DROP VIEW IF EXISTS kernel_v_metric_trigger_state;
CREATE VIEW kernel_v_metric_trigger_state AS
SELECT s.*,
       CASE WHEN s.state = 'breach' THEN 1 ELSE 0 END AS hit
FROM (
  SELECT m.id, m.program_id, m.kind, m.op, m.target, r.value, r.read_at,
    CASE
      WHEN r.value IS NULL
        OR (julianday('now') - julianday(replace(r.read_at, ' ', 'T'))) * 24.0 > m.max_age_h THEN 'unmeasured'
      WHEN (m.op = '>=' AND r.value >= m.target) OR (m.op = '<=' AND r.value <= m.target)
        OR (m.op = '>' AND r.value > m.target) OR (m.op = '<' AND r.value < m.target)
        OR (m.op = '=' AND r.value = m.target) THEN 'on_target'
      ELSE 'breach'
    END AS state
  FROM kernel_metrics m
  LEFT JOIN kernel_metric_readings r
    ON r.id = (SELECT MAX(id) FROM kernel_metric_readings WHERE metric_id = m.id)
) s;

CREATE TABLE IF NOT EXISTS kernel_decisions (
  id TEXT PRIMARY KEY,
  program_id TEXT,
  kind TEXT NOT NULL DEFAULT 'change',      -- change | allocation
  decision TEXT NOT NULL,
  authority TEXT NOT NULL,                  -- the authority the decision used
  prediction TEXT NOT NULL,                 -- '<metric> <op> <n> within <N> h'
  metric_id TEXT,
  op TEXT,
  target REAL,
  target2 REAL,
  window_h REAL,
  due_at TEXT,
  baseline REAL,
  guard_baselines TEXT,                     -- JSON {metric_id: value}
  revert_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',      -- open | kept | reverted | unmeasured | scored
  outcome TEXT,
  observed REAL,
  decided_at TEXT NOT NULL,
  evaluated_at TEXT,
  item_id TEXT
);

CREATE TABLE IF NOT EXISTS kernel_risk_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick_id INTEGER NOT NULL,
  program_id TEXT NOT NULL,
  high INTEGER NOT NULL, open_items INTEGER NOT NULL, guard_breaches INTEGER NOT NULL, stalled INTEGER NOT NULL,
  risk REAL NOT NULL,
  verdict TEXT NOT NULL,                    -- RED | AMBER | GREEN
  quality_index REAL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kernel_snap ON kernel_risk_snapshot(program_id, at);

CREATE TABLE IF NOT EXISTS kernel_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick_id INTEGER NOT NULL,
  program_id TEXT NOT NULL,
  slots INTEGER NOT NULL,
  class TEXT NOT NULL,                      -- constrain | escalate | accelerate | maintain | steady | idle
  risk REAL NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kernel_item_meta (
  item_id TEXT PRIMARY KEY,
  metric_id TEXT,                           -- the metric whose trigger filed or serves this item
  doer TEXT,                                -- who makes the change; null = no doer
  critical INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kernel_focus (
  program_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  tier INTEGER NOT NULL,
  has_doer INTEGER NOT NULL,
  tick_id INTEGER NOT NULL,
  PRIMARY KEY (program_id, item_id)
);

CREATE TABLE IF NOT EXISTS kernel_step_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick_id INTEGER NOT NULL,
  step TEXT NOT NULL,
  ok INTEGER NOT NULL,
  evidence TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kernel_evidence ON kernel_step_evidence(tick_id);

CREATE TABLE IF NOT EXISTS kernel_failure_modes (
  id TEXT PRIMARY KEY,
  name TEXT,
  surface TEXT,
  detector_sql TEXT NOT NULL,               -- one SELECT returning value [, expected]
  fire_when TEXT NOT NULL,                  -- 'value < 0.8*expected' | 'value > 0'
  severity INTEGER NOT NULL,                -- 1 (minor) .. 5 (worst)
  contract_json TEXT NOT NULL,              -- remediation contract (US-17 s4)
  interval_h REAL NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_fired TEXT,
  status TEXT NOT NULL DEFAULT 'armed'      -- armed | probation | retired
);

CREATE TABLE IF NOT EXISTS kernel_failure_mode_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fm_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  value REAL, expected REAL,
  fired INTEGER NOT NULL,
  evidence TEXT,
  confirmed INTEGER                         -- null until verification says whether the firing was real
);
CREATE INDEX IF NOT EXISTS idx_kernel_hits ON kernel_failure_mode_hits(fm_id, id);

CREATE TABLE IF NOT EXISTS kernel_remediations (
  item_id TEXT PRIMARY KEY,
  fm_id TEXT,
  severity INTEGER NOT NULL,
  owner TEXT NOT NULL, doer TEXT NOT NULL, alt_doers TEXT,
  trigger_kind TEXT NOT NULL DEFAULT 'on_fire',
  closing_probe TEXT NOT NULL,
  pass_op TEXT NOT NULL, pass_value REAL NOT NULL,
  max_attempts INTEGER NOT NULL, backoff_h TEXT NOT NULL, deadline_h REAL NOT NULL,
  interrupt_eligible INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',      -- open | closed | needs_human | exhausted
  evidence TEXT
);

CREATE TABLE IF NOT EXISTS kernel_loop_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loop TEXT NOT NULL,
  scanned INTEGER NOT NULL, executed INTEGER NOT NULL, failed INTEGER NOT NULL,
  needs_human INTEGER NOT NULL, no_action INTEGER NOT NULL,
  balanced INTEGER NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kernel_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL, signature TEXT NOT NULL,
  ok INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kernel_attempts ON kernel_attempts(target, signature, at);

CREATE TABLE IF NOT EXISTS kernel_breakers (
  target TEXT NOT NULL, signature TEXT NOT NULL,
  state TEXT NOT NULL,                      -- open | closed
  opened_at TEXT NOT NULL,
  half_open_at TEXT NOT NULL,
  interval_h REAL NOT NULL,
  root_item_id TEXT,
  PRIMARY KEY (target, signature)
);

CREATE TABLE IF NOT EXISTS kernel_remedies (
  id TEXT PRIMARY KEY,
  metric_id TEXT NOT NULL,
  description TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  window_h REAL NOT NULL,
  baseline REAL,
  min_delta REAL NOT NULL DEFAULT 0,
  observed REAL,
  status TEXT NOT NULL DEFAULT 'active',    -- active | effective | replaced
  outcome TEXT,
  replacement_item_id TEXT
);
