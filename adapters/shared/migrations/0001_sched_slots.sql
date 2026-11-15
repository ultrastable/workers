-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- Slot uniqueness for schedulers that can deliver twice (US-14-R03, US-14-R09). The specification describes a unique `slot`
-- column on tick_runs; this adapter keeps the slot in its own table instead (adding a unique column to another module's table
-- cannot be done idempotently). Mapping (US-00-R06): sched_slots.slot = tick_runs.slot, sched_slots.tick_run_id = tick_runs.id.
CREATE TABLE IF NOT EXISTS sched_slots (
  slot INTEGER PRIMARY KEY,                  -- floor(now_ms / slot_ms)
  claimed_at TEXT NOT NULL,
  tick_run_id INTEGER,
  outcome TEXT                               -- completed | incomplete | error
);
