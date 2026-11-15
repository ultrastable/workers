// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Export before drop (US-01-R04). Migrations are additive; one that drops or rewrites data is applied only after every
// affected table has been exported to an object store and the export has been read back and matched. No export, no migration.
// Ports: db (store handle), store (object store: put(key, text), get(key) -> { text() } | string | null; an R2 bucket fits),
// now. Nothing here deletes an export.
const stamp = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const IDENT = `["\`\\[]?([A-Za-z_][A-Za-z0-9_]*)["\`\\]]?`;
const RULES = [
  [new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${IDENT}`, 'i'), 'drop table'],
  [new RegExp(`^ALTER\\s+TABLE\\s+${IDENT}\\s+DROP\\b`, 'i'), 'drop column'],
  [new RegExp(`^ALTER\\s+TABLE\\s+${IDENT}\\s+RENAME\\b`, 'i'), 'rename'],
  [new RegExp(`^DELETE\\s+FROM\\s+${IDENT}`, 'i'), 'delete rows'],
  [new RegExp(`^UPDATE\\s+(?:OR\\s+\\w+\\s+)?${IDENT}`, 'i'), 'rewrite rows'],
  [new RegExp(`^(?:INSERT\\s+OR\\s+REPLACE|REPLACE)\\s+INTO\\s+${IDENT}`, 'i'), 'replace rows'],
  [new RegExp(`^TRUNCATE\\s+(?:TABLE\\s+)?${IDENT}`, 'i'), 'truncate'],
];

/** Split a migration into statements. Understands quotes, line and block comments, and trigger bodies (BEGIN ... END). */
export function splitStatements(sql) {
  const out = []; let cur = ''; let depth = 0; let i = 0; const s = String(sql);
  const word = at => /^[A-Za-z_]+/.exec(s.slice(at))?.[0].toUpperCase();
  while (i < s.length) {
    const c = s[i];
    if (c === '-' && s[i + 1] === '-') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i + 2); i = i < 0 ? s.length : i + 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < s.length) { if (s[j] === c) { if (s[j + 1] === c) j += 2; else break; } else j++; }
      cur += s.slice(i, j + 1); i = j + 1; continue;
    }
    if (/[A-Za-z_]/.test(c) && !/[A-Za-z0-9_]/.test(s[i - 1] || ' ')) {
      const w = word(i);
      if (w === 'BEGIN' && /^\s*CREATE\s+(TEMP\w*\s+)?TRIGGER\b/i.test(cur)) depth++;
      else if (w === 'CASE' && depth) depth++;
      else if (w === 'END' && depth) depth--;
      cur += s.slice(i, i + w.length); i += w.length; continue;
    }
    if (c === ';' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += c; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** What a migration would drop or rewrite: { destructive, tables, findings: [{ table, kind, statement }] }.
 *  Dropping a view, index or trigger loses no data and is not counted. A trigger body is part of the schema, not a rewrite. */
export function classify(sql) {
  const findings = [];
  for (const st of splitStatements(sql)) {
    if (/^CREATE\s+(TEMP\w*\s+)?TRIGGER\b/i.test(st)) continue;
    for (const [re, kind] of RULES) {
      const m = re.exec(st);
      if (m) { findings.push({ table: m[1], kind, statement: st.replace(/\s+/g, ' ').slice(0, 160) }); break; }
    }
  }
  return { destructive: findings.length > 0, tables: [...new Set(findings.map(f => f.table))], findings };
}

async function sha256Hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...d].map(b => b.toString(16).padStart(2, '0')).join('');
}
const bodyText = async o => (o == null ? null : typeof o === 'string' ? o : typeof o.text === 'function' ? o.text() : String(o));

/** An object store held in memory, for tests and dry runs. */
export function memoryStore() {
  const m = new Map();
  return { m, async put(key, text) { m.set(key, String(text)); }, async get(key) { return m.has(key) ? { text: async () => m.get(key) } : null; } };
}

export function createExporter({ db, store, now = () => Date.now(), config = {} } = {}) {
  const clock = typeof now === 'function' ? now : () => now;
  const prefix = config.prefix || 'exports';
  const all = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
  const one = (sql, ...a) => db.prepare(sql).bind(...a).first();
  const run = (sql, ...a) => db.prepare(sql).bind(...a).run();
  const safe = t => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) throw new Error(`not a table name: ${t}`); return t; };

  /** Export one table as JSON lines, read it back, and record the proof. Returns { ok, verified, key, rows, sha256 }. */
  async function exportTable(table, { migration = 'manual' } = {}) {
    if (!store || typeof store.put !== 'function' || typeof store.get !== 'function') return { ok: false, verified: false, error: 'no object store configured' };
    const rows = await all(`SELECT * FROM ${safe(table)}`);
    const body = rows.map(r => JSON.stringify(r)).join('\n');
    const sha = await sha256Hex(body);
    const at = stamp(clock());
    const key = `${prefix}/${migration}/${table}-${at.replace(/[^0-9]/g, '')}.jsonl`;
    let verified = false; let error = null;
    try {
      await store.put(key, body);
      const back = await bodyText(await store.get(key));
      if (back == null) error = 'export could not be read back';
      else {
        const parsed = back === '' ? [] : back.split('\n').map(l => JSON.parse(l));
        if (parsed.length !== rows.length) error = `read back ${parsed.length} rows, wrote ${rows.length}`;
        else if (await sha256Hex(back) !== sha) error = 'read-back body does not match what was written';
        else verified = true;
      }
    } catch (e) { error = `export failed: ${String(e?.message || e).slice(0, 160)}`; }
    await run(`INSERT INTO export_ledger (migration, table_name, object_key, row_count, sha256, verified, at) VALUES (?,?,?,?,?,?,?)`, migration, table, key, rows.length, sha, verified ? 1 : 0, at);
    return verified ? { ok: true, verified, key, rows: rows.length, sha256: sha } : { ok: false, verified, key, rows: rows.length, error };
  }

  /** Apply one migration. Additive: applied. Destructive: every affected table that exists is exported and verified first; any
   *  failure refuses the migration and leaves the store untouched. Each call is recorded in export_migrations. */
  async function applyMigration(name, sql) {
    const c = classify(sql);
    const exports = [];
    if (c.destructive) {
      for (const t of c.tables) {
        const exists = await one(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, t).catch(() => ({ name: t }));
        if (!exists) continue; // nothing to lose: the table is not there
        const e = await exportTable(t, { migration: name });
        exports.push({ table: t, ...e });
        if (!e.ok) {
          const reason = `export of ${t} not verified: ${e.error}`;
          await run(`INSERT INTO export_migrations (name, destructive, tables, outcome, reason, at) VALUES (?,?,?,?,?,?)
            ON CONFLICT(name) DO UPDATE SET outcome=excluded.outcome, reason=excluded.reason, at=excluded.at`, name, 1, JSON.stringify(c.tables), 'refused', reason, stamp(clock()));
          return { ok: false, applied: false, refusal: 'export_not_verified', reason, exports, findings: c.findings };
        }
      }
    }
    for (const st of splitStatements(sql)) await run(st);
    await run(`INSERT INTO export_migrations (name, destructive, tables, outcome, reason, at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET outcome=excluded.outcome, reason=excluded.reason, at=excluded.at`, name, c.destructive ? 1 : 0, JSON.stringify(c.tables), 'applied', null, stamp(clock()));
    return { ok: true, applied: true, destructive: c.destructive, exports, findings: c.findings };
  }

  /** Read an export back as rows (the restore path). */
  async function readExport(key) {
    const back = await bodyText(await store.get(key));
    if (back == null) return null;
    return back === '' ? [] : back.split('\n').map(l => JSON.parse(l));
  }

  return { exportTable, applyMigration, readExport, ledger: () => all(`SELECT * FROM export_ledger ORDER BY id`) };
}

/** Lint migration sources: [{ name, sql }] -> the destructive ones. The seed's own migrations must return []. */
export function lintMigrations(files) {
  return files.map(f => ({ name: f.name, ...classify(f.sql) })).filter(f => f.destructive).map(({ name, findings }) => ({ name, findings }));
}
