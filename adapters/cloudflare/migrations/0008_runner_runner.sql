-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Runner tables (US-SPEC-11). Idempotent. Run state lives here, never in memory, so a restart resumes a run.
-- No secret is ever written to these tables: the version-control token is read from env at request time only.

CREATE TABLE IF NOT EXISTS runner_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  state TEXT NOT NULL,            -- planned|patched|checks_pending|checks_passed|checks_failed|reviewing|approved|pr_opened|rework|refused
  reason TEXT,                    -- why a run was refused or stopped
  rework_count INTEGER NOT NULL DEFAULT 0,
  doer_attempts INTEGER NOT NULL DEFAULT 0,  -- invalid-output retries in the current patch round
  calls INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  branch TEXT,
  head_sha TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  claim_token TEXT,               -- the work-claim token (a lease, not a credential for another system)
  claim_fence INTEGER,
  prediction_id TEXT,
  context_json TEXT,              -- the minimal context given to the doer
  patch_json TEXT,                -- the files last pushed
  checks_json TEXT,               -- the last check results
  review_json TEXT,               -- the last reviewer verdict
  feedback TEXT,                  -- what the next doer round must fix
  checks_since TEXT,
  last_error TEXT,
  error_count INTEGER NOT NULL DEFAULT 0,   -- consecutive failed advances; reset on every state change
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runner_runs_state ON runner_runs(state);
CREATE INDEX IF NOT EXISTS runner_runs_item ON runner_runs(item_id);

CREATE TABLE IF NOT EXISTS runner_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS runner_events_run ON runner_events(run_id);

-- What the doer is told about an item, so the context stays minimal. Optional: "spec:", "target:" and "test:" lines
-- in the item's done_check are read as a fallback.
CREATE TABLE IF NOT EXISTS runner_item_context (
  item_id TEXT PRIMARY KEY,
  spec_ref TEXT,
  spec_text TEXT,
  targets TEXT,                   -- JSON array of repository paths
  test_path TEXT,
  failing_test TEXT
);
