// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// D1-compatible handle over node:sqlite. The portable core (core/src/tick.js) only calls
// db.prepare(sql).bind(...).all()/first()/run(), so any store that offers this surface can run the loops.
// Used by the GCP adapter (SQLite file on a mounted volume) and by tests.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export function openDb(path, migrationsDir) {
  const raw = new DatabaseSync(path);
  raw.exec(`PRAGMA journal_mode=${process.env.ULTRASTABLE_JOURNAL || 'DELETE'}; PRAGMA busy_timeout=5000;`); // DELETE, not WAL: WAL needs shared memory that network volumes lack
  if (migrationsDir) {
    for (const f of readdirSync(migrationsDir).filter(n => n.endsWith('.sql')).sort()) {
      raw.exec(readFileSync(`${migrationsDir}/${f}`, 'utf8')); // migrations are additive and idempotent
    }
  }
  return {
    raw,
    prepare(sql) {
      const st = raw.prepare(sql);
      let args = [];
      const o = {
        bind(...a) { args = a; return o; },
        async all() { return { results: st.all(...args).map(r => ({ ...r })) }; },
        async first() { const r = st.get(...args); return r ? { ...r } : null; },
        async run() { const r = st.run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
      };
      return o;
    },
    close() { raw.close(); },
  };
}
