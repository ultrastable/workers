-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Guided console (US-SPEC-17): every button press and every typed request is a record, never only a UI event.
CREATE TABLE IF NOT EXISTS console_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,            -- card_done | card_default | ask
  ref TEXT,                      -- gate card id, or the item id an ask created
  text TEXT,                     -- the person's own words, verbatim (asks)
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
