// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// SqlPort over node:sqlite for tests and the non-Cloudflare adapters (one file per tenant). node:sqlite does not report rows read,
// so rowsRead is conservative: rows returned, or the table row count when EXPLAIN QUERY PLAN shows a full SCAN.
import { DatabaseSync } from 'node:sqlite';

export function openTenantSql(path = ':memory:') {
  const raw = new DatabaseSync(path);
  return {
    raw,
    exec(text, params = []) {
      const st = raw.prepare(text);
      const isRead = /^\s*(select|with|pragma|explain)\b/i.test(text);
      if (isRead) {
        const rows = st.all(...params).map(r => ({ ...r }));
        let rowsRead = rows.length;
        if (!/^\s*(pragma|explain)\b/i.test(text)) {
          for (const p of raw.prepare('EXPLAIN QUERY PLAN ' + text).all(...params)) {
            const m = /^SCAN (?:TABLE )?(\w+)/.exec(p.detail || '');
            if (m && !m[1].startsWith('sqlite_') && m[1] !== 'CONSTANT') rowsRead = Math.max(rowsRead, raw.prepare(`SELECT COUNT(*) n FROM "${m[1]}"`).get().n);
          }
        }
        return { rows, rowsRead, rowsWritten: 0 };
      }
      const r = st.run(...params);
      return { rows: [], rowsRead: 0, rowsWritten: Number(r.changes) };
    },
  };
}
