-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- core/ownerlink (OWNERLINK-1): every owner action is one link. Idempotent.
CREATE TABLE IF NOT EXISTS ownerlink_actions (
  id TEXT PRIMARY KEY,
  card_id TEXT,
  flow TEXT NOT NULL,
  title TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL,
  extra_link TEXT,
  extra_label TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
  created_at TEXT NOT NULL,
  done_at TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_ownerlink_actions_card ON ownerlink_actions(card_id);

CREATE TABLE IF NOT EXISTS ownerlink_state (
  state TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  flow TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL
);

-- An owner ask (an access gate card with a permit) must carry a link. One without is closed on insert and recorded; the step
-- goes to the staff as an item that builds the missing flow, never to the owner.
CREATE TRIGGER IF NOT EXISTS ownerlink_card_guard AFTER INSERT ON gate_cards
WHEN NEW.status = 'open' AND NOT EXISTS (SELECT 1 FROM ownerlink_actions a WHERE a.card_id = NEW.id)
  AND EXISTS (SELECT 1 FROM access_permits p WHERE p.card_id = NEW.id)
BEGIN
  UPDATE gate_cards SET status = 'closed', closed_at = datetime('now') WHERE id = NEW.id;
  INSERT OR IGNORE INTO access_blocked_asks (card_id, what, why_gated, reason) VALUES (NEW.id, NEW.what, NEW.why_gated, 'no_owner_link: an owner ask must carry one point-and-click link');
  INSERT OR IGNORE INTO items (id, title, kind, owner_role, done_check, closing_probe, priority, status, blocker)
    VALUES ('OWNERLINK-' || NEW.id, 'Build the one-click flow for: ' || substr(NEW.what, 1, 200), 'work', 'staff',
            'core/ownerlink has a flow that obtains this by link, or the capability is acquired by code', NEW.closing_probe, 20, 'blocked', 'waiting on probe: ' || NEW.closing_probe);
END;
