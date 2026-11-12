-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Analytics pack tables (US-SPEC-21 class A). Idempotent. No IP, cookie or fingerprint is ever stored.

CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  day TEXT NOT NULL,
  path TEXT NOT NULL,                            -- no query string
  referrer TEXT,                                 -- host only
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  visitor_hash TEXT NOT NULL                     -- sha256(salt|day|ip|ua): changes every day, cannot link days
);
CREATE INDEX IF NOT EXISTS idx_analytics_events_day ON analytics_events(day);

CREATE TABLE IF NOT EXISTS analytics_daily (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  pageviews INTEGER NOT NULL,
  visitors INTEGER NOT NULL,
  PRIMARY KEY (day, path)
);

CREATE TABLE IF NOT EXISTS analytics_sources (
  day TEXT NOT NULL,
  source TEXT NOT NULL,                          -- utm_source, else referrer host, else '(direct)'
  pageviews INTEGER NOT NULL,
  PRIMARY KEY (day, source)
);

CREATE TABLE IF NOT EXISTS analytics_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  pageviews_7d INTEGER NOT NULL,
  visitors_today INTEGER NOT NULL,
  raw_events INTEGER NOT NULL,
  purged INTEGER NOT NULL
);
