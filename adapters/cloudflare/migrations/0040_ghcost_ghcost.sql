-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- core/ghcost (US-SPEC-24): minutes ledger, workflow kill switch and desired state, probe and drill records, census.
CREATE TABLE IF NOT EXISTS ghcost_ledger (
  month TEXT NOT NULL,                 -- YYYY-MM
  repo TEXT NOT NULL,                  -- repository name, or '(total)'
  minutes_used REAL NOT NULL,          -- Linux-equivalent minutes
  budget REAL NOT NULL,
  ratio REAL NOT NULL,
  decision TEXT NOT NULL,              -- ok | warn50 | warn80 | over
  updated_at TEXT NOT NULL,
  published_at TEXT,                   -- set once, when the month's rows are published
  PRIMARY KEY (month, repo)
);
CREATE TABLE IF NOT EXISTS ghcost_switches (
  id TEXT PRIMARY KEY,                 -- 'workflows'
  is_on INTEGER NOT NULL DEFAULT 0,    -- 1 = every non-essential workflow is disabled
  reason TEXT,
  set_by TEXT,
  set_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ghcost_workflows (
  repo TEXT NOT NULL,
  workflow TEXT NOT NULL,              -- 'file.yml' or 'file.yml:job'
  desired TEXT NOT NULL,               -- enabled | disabled
  observed TEXT,                       -- enabled | disabled | unknown, read back from the platform
  reason TEXT,                         -- over | kill_switch | null
  changed_at TEXT NOT NULL,
  checked_at TEXT,
  PRIMARY KEY (repo, workflow)
);
CREATE TABLE IF NOT EXISTS ghcost_probes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  probe TEXT NOT NULL,                 -- spending_limit | watchdog | deadman | census | monitor | public_checklist:<repo> | secret_history:<repo>
  result TEXT NOT NULL,                -- pass | fail | unknown
  evidence TEXT,
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ghcost_probes_by_probe ON ghcost_probes (probe, id);
CREATE TABLE IF NOT EXISTS ghcost_drills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  disabled_all INTEGER NOT NULL,       -- 1 when every non-essential workflow read back disabled while the switch was on
  switch_off_after INTEGER NOT NULL,   -- always 1: the drill turns the switch off in every case
  error TEXT
);
CREATE TABLE IF NOT EXISTS ghcost_census (
  repo TEXT NOT NULL,
  workflow TEXT NOT NULL,
  state TEXT,                          -- platform state of the workflow
  runs INTEGER NOT NULL,
  last_run_at TEXT,
  runners TEXT,                        -- JSON list of runner labels seen
  in_roster INTEGER NOT NULL,
  status TEXT NOT NULL,                -- active | idle | unmeasured
  measured_at TEXT NOT NULL,
  PRIMARY KEY (repo, workflow)
);
