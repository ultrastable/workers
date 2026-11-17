-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
CREATE TABLE IF NOT EXISTS promote_posts (
  idem TEXT PRIMARY KEY, tenant TEXT NOT NULL, channel TEXT NOT NULL, entry_id TEXT NOT NULL, text TEXT NOT NULL,
  status TEXT NOT NULL, detail TEXT, at TEXT NOT NULL, referrals INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS promote_metrics (tenant TEXT NOT NULL, day TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY (tenant, day, metric));
CREATE TABLE IF NOT EXISTS promote_weights (tenant TEXT NOT NULL, channel TEXT NOT NULL, weight REAL NOT NULL, at TEXT NOT NULL, PRIMARY KEY (tenant, channel));
