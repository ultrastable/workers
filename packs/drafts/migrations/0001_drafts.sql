-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Drafts pack tables (US-SPEC-21 class C). Idempotent. Draft-only: nothing here is ever sent.

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idem_key TEXT UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('plan','patent','legal')),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','taken','closed')),
  version INTEGER NOT NULL DEFAULT 1,
  taken_by TEXT,                                 -- the person who took it elsewhere; only they can set this
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,                            -- always begins with the draft banner
  body_sha256 TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (draft_id, version)
);

CREATE TABLE IF NOT EXISTS drafts_rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT,
  title TEXT,
  violations TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  open_drafts INTEGER NOT NULL,
  stale INTEGER NOT NULL,
  versions_7d INTEGER NOT NULL
);
