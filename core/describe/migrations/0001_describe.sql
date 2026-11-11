-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- core/describe: the claims registry and generated outputs (US-SPEC-22 s5). Idempotent.

CREATE TABLE IF NOT EXISTS describe_claims (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,                       -- template; {value}, {names}, {date} are filled from the last probe
  probe_kind TEXT NOT NULL,                 -- sql | file | http | spec
  probe_arg TEXT NOT NULL,
  expect TEXT NOT NULL,                     -- >=N, <=N, >N, <N, =N, !=N, exists, nonempty, contains:X, status:N
  max_age_hours REAL NOT NULL DEFAULT 24,
  public INTEGER NOT NULL DEFAULT 1,
  last_result TEXT,                         -- pass | fail | unknown | null before the first probe
  last_checked_at TEXT,
  evidence TEXT,                            -- JSON: { value, names, detail }
  withdrawn INTEGER NOT NULL DEFAULT 0,
  withdrawn_at TEXT
);

CREATE TABLE IF NOT EXISTS describe_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form TEXT NOT NULL,                       -- statement | page | json | llms
  claim_ids TEXT NOT NULL,                  -- JSON array
  body TEXT NOT NULL,
  generated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_describe_outputs_form ON describe_outputs(form, id);
