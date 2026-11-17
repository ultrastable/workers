-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
-- core/access: the access preflight. A request for the owner's help (a gate card) about access, permission, credential or install
-- is refused by the database itself unless a permit exists, and a permit exists only when the latest probe shows the capability
-- truly missing after every route was tried. Idempotent.

CREATE TABLE IF NOT EXISTS access_state (
  capability TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present','missing','unknown')),
  probe_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  evidence TEXT NOT NULL,
  PRIMARY KEY (capability, subject)
);

-- One row per route per probe; probe_id ties the rows to the access_state row that summarizes them.
CREATE TABLE IF NOT EXISTS access_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capability TEXT NOT NULL,
  subject TEXT NOT NULL,
  route TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('present','absent','unknown')),
  detail TEXT NOT NULL,
  at TEXT NOT NULL,
  probe_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_routes_cap ON access_routes(capability, subject, at);

CREATE TABLE IF NOT EXISTS access_permits (
  card_id TEXT PRIMARY KEY,
  capability TEXT NOT NULL,
  subject TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_blocked_asks (
  card_id TEXT PRIMARY KEY,
  what TEXT NOT NULL,
  why_gated TEXT NOT NULL,
  reason TEXT NOT NULL,
  blocked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A permit cannot be written unless the capability's newest probe says missing, is still fresh, found no route present or
-- unknown, and found at least one route authoritatively absent.
CREATE TRIGGER IF NOT EXISTS access_permit_guard BEFORE INSERT ON access_permits
WHEN NOT EXISTS (
  SELECT 1 FROM access_state s
  WHERE s.capability = NEW.capability AND s.subject = NEW.subject AND s.status = 'missing' AND s.expires_at >= NEW.at
    AND EXISTS (SELECT 1 FROM access_routes r WHERE r.capability = s.capability AND r.subject = s.subject AND r.probe_id = s.probe_id AND r.outcome = 'absent')
    AND NOT EXISTS (SELECT 1 FROM access_routes r WHERE r.capability = s.capability AND r.subject = s.subject AND r.probe_id = s.probe_id AND r.outcome IN ('present','unknown'))
)
BEGIN
  SELECT RAISE(ABORT, 'access_permit_refused: the capability is not proven missing by a fresh probe of every route');
END;

-- The owner-ask gate. Any gate card that reads as a request for access, permission, a credential or an install is closed on
-- insert, recorded, and its step goes to the staff as an item, unless a permit names the card or it is a money, signing, legal
-- or destructive request (identity-bound and handled by the interrupt gate).
CREATE TRIGGER IF NOT EXISTS access_ask_guard AFTER INSERT ON gate_cards
WHEN NEW.status = 'open'
  AND NOT EXISTS (SELECT 1 FROM access_permits p WHERE p.card_id = NEW.id)
  AND (lower(NEW.what || ' ' || NEW.why_gated) LIKE '%access to%'
    OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%need access%'
    OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%permission%'
    OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%credential%'
    OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%secret%'
    OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%api key%'
    OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%api token%'
    OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%access token%'
    OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%_token%'
    OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%oauth%'
    OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%authoriz%'
    OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%authoris%'
    OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%install the%'
    OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%app install%'
    OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%needs:%'
    OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%sign in%'
    OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%log in%'
    OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%grant %')
  AND NOT (lower(NEW.what || ' ' || NEW.why_gated) LIKE '%money%' OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%payment%'
    OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%legal%' OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%sign a %'
    OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%destroy%' OR lower(NEW.what || ' ' || NEW.why_gated) LIKE '%irreversible%')
BEGIN
  UPDATE gate_cards SET status = 'closed', closed_at = datetime('now') WHERE id = NEW.id;
  INSERT OR IGNORE INTO access_blocked_asks (card_id, what, why_gated, reason) VALUES (NEW.id, NEW.what, NEW.why_gated, 'no permit: the request was not preceded by a probe proving the capability missing');
  -- A request for a named setting becomes a blocked item that the tick re-reads every tick (its probe is the card's own env probe),
  -- so the work closes by itself when the setting arrives and never pulls a runner onto an item with no target.
  INSERT OR IGNORE INTO items (id, title, kind, owner_role, done_check, closing_probe, priority, status, blocker)
    SELECT 'ACCESS-' || NEW.id, 'Get this without asking the owner: ' || substr(NEW.what, 1, 200), 'work', 'staff',
           'the capability is present per core/access, acquired by code on every route', NEW.closing_probe, 20, 'blocked', 'waiting on probe: ' || NEW.closing_probe
    WHERE NEW.closing_probe LIKE 'env:%';
END;
