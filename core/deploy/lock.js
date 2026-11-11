// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Built-in deploy lock on the db (US-07-R12). Same shape as any injected lock port: acquire(unit, holder, ttlMs) -> token|null, release(unit, token).
export function dbLock(db, now = () => Date.now()) {
  return {
    async acquire(unit, holder, ttlMs) {
      const t = new Date(now()).toISOString();
      await db.prepare(`DELETE FROM deploy_lock WHERE unit=? AND expires_at <= ?`).bind(unit, t).run();
      const token = crypto.randomUUID();
      const r = await db.prepare(`INSERT OR IGNORE INTO deploy_lock (unit, holder, token, acquired_at, expires_at) VALUES (?,?,?,?,?)`)
        .bind(unit, holder, token, t, new Date(now() + ttlMs).toISOString()).run();
      return r.meta.changes === 1 ? token : null;
    },
    async release(unit, token) {
      await db.prepare(`DELETE FROM deploy_lock WHERE unit=? AND token=?`).bind(unit, token).run();
    },
  };
}
