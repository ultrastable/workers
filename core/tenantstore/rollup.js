// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Rollups: aggregates are maintained when a row is written, so a loop that wants "counts by status" or "last run per job"
// reads one row, not a scan of the table. This is the cure for ticks that scan whole views.
export const SCHEMA = `CREATE TABLE IF NOT EXISTS _rollup (name TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, sum REAL NOT NULL DEFAULT 0, last_at TEXT, last_val TEXT, PRIMARY KEY(name,key));`;

export class Rollups {
  constructor(sql, guard, now = () => new Date()) { this.sql = sql; this.guard = guard; this.now = now; this.sql.exec(SCHEMA); }
  // One write, O(1): call it in the same unit of work as the row it summarizes.
  add(name, key, { n = 1, sum = 0, val = null } = {}) {
    this.guard.check();
    const r = this.sql.exec(`INSERT INTO _rollup(name,key,n,sum,last_at,last_val) VALUES(?,?,?,?,?,?)
      ON CONFLICT(name,key) DO UPDATE SET n=n+excluded.n, sum=sum+excluded.sum, last_at=excluded.last_at, last_val=COALESCE(excluded.last_val,last_val)`,
      [name, key, n, sum, this.now().toISOString(), val === null ? null : String(val)]);
    this.guard.record({ writes: r.rowsWritten });
  }
  get(name, key) { this.guard.check(); const r = this.sql.exec('SELECT * FROM _rollup WHERE name=? AND key=?', [name, key]); this.guard.record({ reads: r.rowsRead }); return r.rows[0] || null; }
  all(name, limit = 500) { this.guard.check(); const r = this.sql.exec('SELECT * FROM _rollup WHERE name=? ORDER BY key LIMIT ?', [name, limit]); this.guard.record({ reads: r.rowsRead }); return r.rows; }
}
