-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
CREATE TABLE IF NOT EXISTS outreach_intents (
  id TEXT PRIMARY KEY, tenant TEXT NOT NULL, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, evidence_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_approval', approved_by TEXT, created_at TEXT NOT NULL, sent_at TEXT);
CREATE TABLE IF NOT EXISTS outreach_suppressed (addr TEXT PRIMARY KEY, why TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outreach_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, intent_id TEXT NOT NULL, to_addr TEXT NOT NULL, at TEXT NOT NULL, result TEXT NOT NULL, text TEXT);
