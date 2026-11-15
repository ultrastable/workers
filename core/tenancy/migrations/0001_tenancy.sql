-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- core/tenancy (US-SPEC-10 s7): tenant registry, hourly aggregates pushed by tenants, isolation probe results, canary rows.
CREATE TABLE IF NOT EXISTS tenancy_tenants (
  slug TEXT PRIMARY KEY,
  level INTEGER NOT NULL DEFAULT 2,      -- 1 account per tenant | 2 database and worker per tenant | 3 shared database, tenant id by policy
  runtime TEXT,
  bundle_sha256 TEXT,
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tenancy_aggregates (
  slug TEXT NOT NULL,
  hour TEXT NOT NULL,                    -- YYYY-MM-DD HH
  payload TEXT NOT NULL,                 -- JSON of counts only; never item text
  received_at TEXT NOT NULL,
  PRIMARY KEY (slug, hour)
);
CREATE TABLE IF NOT EXISTS tenancy_probes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_a TEXT NOT NULL,                -- the canary is written here
  tenant_b TEXT NOT NULL,                -- and read with this tenant's credentials
  level INTEGER NOT NULL,
  result TEXT NOT NULL,                  -- pass | fail | unknown
  severity TEXT,                         -- 'severe' on a fail
  detail TEXT,
  canary_deleted INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tenancy_probes_pair ON tenancy_probes (tenant_a, tenant_b, id);
CREATE TABLE IF NOT EXISTS tenancy_canary (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
