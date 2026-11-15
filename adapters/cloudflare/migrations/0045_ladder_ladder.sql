-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Model ladder persistence (US-SPEC-09 sections 4 and 5): capability matrix, admission pipeline, canary runs, shadow
-- samples, attempt rows and the cost-per-task view. Idempotent. The spec's model_task_matrix and model_admission tables
-- carry the module prefix here. Writes ladder_* tables and work items only.

CREATE TABLE IF NOT EXISTS ladder_model_task_matrix (
  task_class TEXT NOT NULL, rung INTEGER NOT NULL, model TEXT NOT NULL,
  unit_cost REAL NOT NULL, canary_tool_calls INTEGER, canary_schema INTEGER,
  ctx_tokens INTEGER, max_out INTEGER, agreement REAL,
  admitted_at TEXT, probed_at TEXT,
  PRIMARY KEY (task_class, rung, model)
);

CREATE TABLE IF NOT EXISTS ladder_model_admission (
  id INTEGER PRIMARY KEY, model TEXT, task_class TEXT,
  stage TEXT,                               -- floor | canary | agreement | admitted | demoted | rejected
  n INTEGER, agree REAL, lower_bound REAL, gate REAL,
  decided_at TEXT, reason TEXT, evidence TEXT
);
CREATE INDEX IF NOT EXISTS idx_ladder_admission ON ladder_model_admission(model, task_class, id);

-- The banned classes of the model floor, as patterns over model ids. A change here is seen by the monitor.
CREATE TABLE IF NOT EXISTS ladder_floor_banned (
  pattern TEXT PRIMARY KEY,                 -- regular expression, case-insensitive
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ladder_canary_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model TEXT NOT NULL, task_class TEXT NOT NULL,
  tool_calls INTEGER, schema_ok INTEGER,
  passed INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ladder_canary ON ladder_canary_runs(model, task_class, id);

-- About 5% of decisions are answered a second time and compared with the organization's label.
CREATE TABLE IF NOT EXISTS ladder_shadow_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model TEXT NOT NULL, task_class TEXT NOT NULL,
  decision_ref TEXT,
  model_answer TEXT, label TEXT,
  agree INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ladder_shadow ON ladder_shadow_samples(model, task_class, id);

-- One row per attempt at a task. An escalation carries the measured signal that caused it.
CREATE TABLE IF NOT EXISTS ladder_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL, task_class TEXT NOT NULL,
  layer TEXT NOT NULL,                      -- cascade | draft | repair
  rung INTEGER, model TEXT,
  cost REAL NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL,
  signal TEXT,                              -- schema | tool_call_parse | empty | truncation | low_confidence | provider_error | check:<name>
  steered INTEGER NOT NULL DEFAULT 0,       -- 1 when a breached cap kept the task on a free rung
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ladder_attempts ON ladder_attempts(task_class, task_id);

-- Cost per verified outcome and escalation rate per task class (US-09-R10).
DROP VIEW IF EXISTS ladder_v_cost_per_task;
CREATE VIEW ladder_v_cost_per_task AS
SELECT task_class,
       COUNT(*) AS tasks,
       SUM(verified) AS verified,
       SUM(cost) AS spend,
       SUM(attempts) AS attempts,
       CASE WHEN SUM(verified) > 0 THEN SUM(cost) / SUM(verified) END AS cost_per_verified_outcome,
       1.0 * SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END) / COUNT(*) AS escalation_rate
FROM (SELECT task_class, task_id, MAX(verified) AS verified, SUM(cost) AS cost, COUNT(*) AS attempts FROM ladder_attempts GROUP BY task_class, task_id)
GROUP BY task_class;
