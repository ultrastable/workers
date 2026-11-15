// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Postgres dialect shim (US-SPEC-14 section 4, "Store dialect"). The core writes SQLite-flavoured SQL against the store handle
// (US-14-R02); this turns each statement into Postgres and wraps any client that has query(text, params) -> { rows, rowCount }
// into that handle. No driver is imported: the client is a port (node-postgres, a serverless driver or a pooled proxy all fit).
//   ?                       -> $1, $2, ...            (outside strings and comments)
//   INSERT OR IGNORE        -> INSERT ... ON CONFLICT DO NOTHING
//   datetime('now')         -> UTC text 'YYYY-MM-DD HH:MM:SS', so string comparison still orders time (US-14-R06, US-00-R05)
//   datetime('now', '-1 hour') and the like -> the same with an interval
//   INTEGER PRIMARY KEY AUTOINCREMENT -> BIGSERIAL PRIMARY KEY
//   last_row_id             -> RETURNING id, added to an INSERT into a table known to have a serial id
//   SUM(a = b) and other bare boolean sums -> SUM(CASE WHEN ... THEN 1 ELSE 0 END)
const NOW_TEXT = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;
const nowPlus = (mod) => {
  const m = /^\s*([+-]?\d+(?:\.\d+)?)\s+(second|minute|hour|day|month|year)s?\s*$/i.exec(mod);
  if (!m) throw new Error(`datetime modifier not supported by the Postgres shim: ${mod}`);
  return `to_char((now() AT TIME ZONE 'UTC') + interval '${m[1]} ${m[2].toLowerCase()}', 'YYYY-MM-DD HH24:MI:SS')`;
};

/** Split SQL into code and literal segments so rewrites never touch a string, a quoted name or a comment. */
function segments(sql) {
  const out = []; let i = 0; let code = '';
  const push = (text, lit) => { if (text) out.push({ text, lit }); };
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === c) { if (sql[j + 1] === c) j += 2; else break; } else j++; }
      push(code, false); code = ''; push(sql.slice(i, j + 1), true); i = j + 1; continue;
    }
    if (c === '-' && sql[i + 1] === '-') { let j = sql.indexOf('\n', i); if (j < 0) j = sql.length; push(code, false); code = ''; push(sql.slice(i, j), true); i = j; continue; }
    code += c; i++;
  }
  push(code, false);
  return out;
}

/** Translate one statement. Returns { text, returning } where `returning` says the shim appended RETURNING id.
 *  `serialTables` is the set of tables whose id is a serial; translating DDL adds to it. */
export function translate(sql, { serialTables = new Set() } = {}) {
  let s = String(sql).trim().replace(/;\s*$/, '');
  // datetime('now'[, modifier]) spans a string literal, so it is rewritten before the split.
  s = s.replace(/datetime\(\s*'now'\s*(?:,\s*'([^']*)'\s*)?\)/gi, (_m, mod) => (mod ? nowPlus(mod) : NOW_TEXT));
  // SQLite sums a bare comparison as 0 or 1; Postgres needs the CASE spelled out. The argument may hold a string literal.
  s = s.replace(/\bSUM\(\s*((?:'[^']*'|[^()'])*?)\s*\)/gi, (m, expr) => {
    const bare = expr.replace(/'[^']*'/g, "''");
    return /^\s*CASE\b/i.test(bare) || !/(=|<>|!=|>|<|\bIS\s+(NOT\s+)?NULL\b)/i.test(bare) ? m : `SUM(CASE WHEN ${expr} THEN 1 ELSE 0 END)`;
  });
  const ignore = /^\s*INSERT\s+OR\s+IGNORE\b/i.test(s);
  if (/^\s*INSERT\s+OR\s+REPLACE\b/i.test(s) || /^\s*REPLACE\s+INTO\b/i.test(s)) throw new Error('INSERT OR REPLACE has no direct Postgres form: write ON CONFLICT (...) DO UPDATE');
  const create = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/i.exec(s);
  let n = 0;
  const parts = segments(s).map(seg => {
    if (seg.lit) return seg.text;
    let t = seg.text;
    t = t.replace(/\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT');
    t = t.replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'BIGSERIAL PRIMARY KEY');
    t = t.replace(/\bAUTOINCREMENT\b/gi, '');
    t = t.replace(/\?/g, () => `$${++n}`);
    return t;
  });
  let text = parts.join('');
  if (create && /\bBIGSERIAL PRIMARY KEY\b/.test(text) && /\(\s*id\s+BIGSERIAL\b/i.test(text.replace(/--[^\n]*/g, ''))) serialTables.add(create[1].toLowerCase());
  if (create) text = text.replace(/\bREAL\b/g, 'DOUBLE PRECISION');
  if (ignore && !/\bON\s+CONFLICT\b/i.test(text)) text += ' ON CONFLICT DO NOTHING';
  let returning = false;
  const ins = /^\s*INSERT\s+INTO\s+["`]?(\w+)/i.exec(text);
  if (ins && serialTables.has(ins[1].toLowerCase()) && !/\bRETURNING\b/i.test(text)) { text += ' RETURNING id'; returning = true; }
  return { text, returning, params: n };
}

/** Split a migration file into statements (quotes, comments and trigger bodies respected) and translate each. */
export function translateMigration(sql, opts = {}) {
  const out = []; let cur = '';
  for (const seg of segments(String(sql))) {
    if (seg.lit) { if (!seg.text.startsWith('--')) cur += seg.text; continue; }
    const pieces = seg.text.split(';');
    pieces.forEach((p, i) => { cur += p; if (i < pieces.length - 1) { if (cur.trim()) out.push(cur.trim()); cur = ''; } });
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map(st => translate(st, opts).text);
}

/** The store handle (US-14-R02) over a Postgres client. `client.query(text, params)` must resolve to { rows, rowCount }. */
export function createPgStore(client, { serialTables = new Set() } = {}) {
  if (!client || typeof client.query !== 'function') throw new Error('a client with query(text, params) is required');
  return {
    serialTables,
    async migrate(sql) { for (const text of translateMigration(sql, { serialTables })) await client.query(text, []); },
    prepare(sql) {
      const { text, returning } = translate(sql, { serialTables });
      let args = [];
      const o = {
        bind(...a) { args = a.map(v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)); return o; },
        async all() { return { results: (await client.query(text, args)).rows || [] }; },
        async first() { return ((await client.query(text, args)).rows || [])[0] ?? null; },
        async run() {
          const r = await client.query(text, args);
          const id = returning && r.rows && r.rows[0] ? Number(r.rows[0].id) : null;
          return { meta: { changes: Number(r.rowCount ?? 0), last_row_id: id } };
        },
      };
      return o;
    },
  };
}
