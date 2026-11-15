-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Predict, act, verify, score (US-SPEC-05): decision log, prediction table, outcome rows, calibration views, realization gate.
-- Idempotent. Reads the seed tables items and outcomes; writes only predict_* tables plus one outcomes row per scored prediction.

CREATE TABLE IF NOT EXISTS predict_decisions (
  id TEXT PRIMARY KEY,
  decided_at TEXT NOT NULL,
  actor TEXT,
  persona TEXT,
  action_class TEXT,
  surface TEXT,
  decision_type TEXT,
  decision TEXT NOT NULL,
  reason TEXT,
  predicted_outcome TEXT NOT NULL,          -- free text; the parsable forms are copied to predict_predictions
  revert_path TEXT NOT NULL,
  confidence REAL,                          -- stated confidence p in [0.5, 1], optional
  parsable INTEGER NOT NULL DEFAULT 0,
  item_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_predict_decisions_at ON predict_decisions(decided_at);

CREATE TABLE IF NOT EXISTS predict_predictions (
  id TEXT PRIMARY KEY,
  decision_id TEXT,
  origin TEXT NOT NULL DEFAULT 'parsed' CHECK (origin IN ('parsed','seeded')),
  form TEXT NOT NULL CHECK (form IN ('metric','issue')),
  subject TEXT NOT NULL,                    -- metric name or issue id
  op TEXT NOT NULL,                         -- < <= > >= = between closed
  value REAL,
  value2 REAL,
  due_at TEXT NOT NULL,
  confidence REAL,
  decision_type TEXT,
  persona TEXT,
  action_class TEXT,
  surface TEXT,
  observed REAL,
  matched INTEGER,                          -- null until scored; 1 held, 0 missed
  scored_at TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_predict_predictions_due ON predict_predictions(matched, due_at);

CREATE TABLE IF NOT EXISTS predict_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_id TEXT NOT NULL,
  decision_id TEXT,
  observed REAL,
  matched INTEGER NOT NULL,
  reason TEXT,
  scored_at TEXT NOT NULL
);

-- A metric the scorer can compute: one read-only SELECT returning one number.
CREATE TABLE IF NOT EXISTS predict_metrics (
  name TEXT PRIMARY KEY,
  read_sql TEXT NOT NULL,
  description TEXT
);

-- Aggregate calibration: matched share by persona, action class and surface (US-SPEC-05 s3.2).
DROP VIEW IF EXISTS predict_v_calibration_persona;
CREATE VIEW predict_v_calibration_persona AS
SELECT COALESCE(persona, '') AS persona, COUNT(*) AS scored, SUM(matched) AS matched, 1.0 * SUM(matched) / COUNT(*) AS matched_share
FROM predict_predictions WHERE matched IS NOT NULL GROUP BY COALESCE(persona, '');

DROP VIEW IF EXISTS predict_v_calibration_action_class;
CREATE VIEW predict_v_calibration_action_class AS
SELECT COALESCE(action_class, '') AS action_class, COUNT(*) AS scored, SUM(matched) AS matched, 1.0 * SUM(matched) / COUNT(*) AS matched_share
FROM predict_predictions WHERE matched IS NOT NULL GROUP BY COALESCE(action_class, '');

DROP VIEW IF EXISTS predict_v_calibration_surface;
CREATE VIEW predict_v_calibration_surface AS
SELECT COALESCE(surface, '') AS surface, COUNT(*) AS scored, SUM(matched) AS matched, 1.0 * SUM(matched) / COUNT(*) AS matched_share
FROM predict_predictions WHERE matched IS NOT NULL GROUP BY COALESCE(surface, '');

-- Binned calibration per decision type (US-05-R13). Bin b covers [0.5 + 0.1*b, 0.6 + 0.1*b); p = 1.0 falls in the last bin.
DROP VIEW IF EXISTS predict_v_calibration_bins;
CREATE VIEW predict_v_calibration_bins AS
SELECT COALESCE(decision_type, '') AS decision_type,
       MIN(4, CAST((confidence - 0.5) * 10 + 0.000001 AS INTEGER)) AS bin,
       COUNT(*) AS n, AVG(confidence) AS mean_p, 1.0 * SUM(matched) / COUNT(*) AS hit_rate,
       SUM((confidence - matched) * (confidence - matched)) AS sq_err
FROM predict_predictions
WHERE matched IS NOT NULL AND confidence IS NOT NULL AND confidence >= 0.5 AND confidence <= 1.0
GROUP BY COALESCE(decision_type, ''), MIN(4, CAST((confidence - 0.5) * 10 + 0.000001 AS INTEGER));

-- The correction applied to stated confidence that gates autonomous action, recomputed by calibrate().
CREATE TABLE IF NOT EXISTS predict_confidence_caps (
  decision_type TEXT NOT NULL,
  bin INTEGER NOT NULL,
  n INTEGER NOT NULL,
  mean_p REAL NOT NULL,
  hit_rate REAL NOT NULL,
  correction REAL NOT NULL,                 -- mean_p - hit_rate when positive and n is large enough, else 0
  computed_at TEXT NOT NULL,
  PRIMARY KEY (decision_type, bin)
);

-- Realization gate (US-SPEC-05 s3.3): one row per assertion about a fix; the latest row of a finding decides.
CREATE TABLE IF NOT EXISTS predict_assertions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id TEXT NOT NULL,                 -- items.id of the finding
  state TEXT NOT NULL CHECK (state IN ('code-only','staged','inferred','observed')),
  deciding_query TEXT,
  pass_condition TEXT,
  fail_condition TEXT,
  null_expectation TEXT,
  query_value REAL,                         -- what the deciding query read, when the gate ran it
  evidence TEXT,
  produced_by TEXT,
  verified_by TEXT,
  independent INTEGER,                      -- 1 when the verifying path differs from the producing one (US-05-R12)
  retest_at TEXT,
  retested_at TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_predict_assertions_finding ON predict_assertions(finding_id, id);
