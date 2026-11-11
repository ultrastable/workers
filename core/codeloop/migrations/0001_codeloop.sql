-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
CREATE TABLE IF NOT EXISTS codeloop_merges (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, item_id TEXT, pr_number INTEGER,
  decision TEXT NOT NULL,        -- merged | refused | failed
  host TEXT, reason TEXT, attempts_json TEXT, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS codeloop_merges_run ON codeloop_merges(run_id);
