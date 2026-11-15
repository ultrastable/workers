-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
CREATE TABLE IF NOT EXISTS containers_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, idem_key TEXT UNIQUE, job_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  attempts INTEGER NOT NULL DEFAULT 0, lease_until_ms INTEGER, executor TEXT, exit_code INTEGER,
  stdout TEXT, stderr TEXT, error TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS containers_jobs_status ON containers_jobs(status, id);
