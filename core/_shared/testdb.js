// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Test helper: a D1-shaped in-memory database with the seed migrations plus any extra migration directories.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SEED_MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));

export function makeDb(extraMigrationDirs = []) {
  const raw = new DatabaseSync(':memory:');
  for (const dir of [SEED_MIGRATIONS, ...extraMigrationDirs]) {
    for (const f of readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) raw.exec(readFileSync(path.join(dir, f), 'utf8'));
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
  };
}
