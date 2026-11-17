// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// A {get, put} store over a D1-style handle, so the registry runs wherever a database does (a KV namespace fits the same port).
export const dbStore = db => ({
  async get(k) { const r = await db.prepare(`SELECT value FROM ignorance_state WHERE key=?`).bind(k).first(); return r ? r.value : null; },
  async put(k, v) { await db.prepare(`INSERT INTO ignorance_state (key, value, updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).bind(k, v).run(); },
});
