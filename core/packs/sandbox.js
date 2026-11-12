// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Pack sandbox (US-21-R06, R08): a pack loop never receives the raw db, the tick context or an unbound guard.
//  - sandboxDb: a db port whose statements are checked before they are prepared. Writes only to the pack's own tables
//    (`<id>_*`) plus `items` and `predictions`; no DDL, no PRAGMA/ATTACH, no multi-statement text, no quoted identifiers,
//    no access to the registry, switches or consent tokens.
//  - sandboxCtx: the tick context without env, config or db.
//  - freezeGuard: the bound guard with no mutable surface.
//  - scanPackSource: static check at registration that a pack imports nothing that reaches the raw guard or the platform.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CORE_DIR = fileURLToPath(new URL('../', import.meta.url));
export const SHARED_WRITE_TABLES = ['items', 'predictions'];
const NO_ACCESS = /\b(packs_registry|packs_switches|guard_consent)\b/i;
const DDL = /^\s*(create|drop|alter|pragma|attach|detach|vacuum|reindex|analyze)\b|\bload_extension\b/i;
const WRITE_TARGET = /\b(?:insert\s+(?:or\s+\w+\s+)?into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+([A-Za-z_][\w.]*)/gi;

// Strip comments and string literals so keywords inside text cannot hide or fake a table reference.
export function stripSql(sql) {
  return String(sql).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''");
}

// Returns a reason string when the statement is refused, else null.
export function checkSql(sql, packId) {
  const s = stripSql(sql);
  if (/["`\[]/.test(s)) return 'quoted_identifier';
  if (/;\s*\S/.test(s)) return 'multiple_statements';
  if (DDL.test(s)) return 'ddl_or_pragma';
  if (NO_ACCESS.test(s)) return 'forbidden_table';
  const own = `${packId}_`;
  for (const m of s.matchAll(WRITE_TARGET)) {
    const t = m[1].toLowerCase();
    if (!(t.startsWith(own) || SHARED_WRITE_TABLES.includes(t))) return `write_outside_pack:${t}`;
  }
  return null;
}

export function sandboxDb(db, packId) {
  if (!/^[a-z][a-z0-9_]*$/.test(String(packId))) throw new Error('sandboxDb: bad pack id');
  return Object.freeze({
    prepare(sql) {
      const why = checkSql(sql, packId);
      if (why) throw new Error(`pack sandbox refused statement (${why})`);
      return db.prepare(sql);
    },
  });
}

export function sandboxCtx(ctx) {
  return Object.freeze({ tickId: ctx.tickId, nowIso: ctx.nowIso, now: ctx.now, notes: ctx.notes, errors: ctx.errors });
}

export function freezeGuard(g) {
  return Object.freeze({ ...g, consent: Object.freeze({ ...g.consent }) });
}

// ---- static source scan ----
const ALLOWED_CORE = [
  { file: 'kernel/util.js' }, { dir: 'describe/' },
  { file: 'packs/guard.js', names: ['sha256'] },     // a pure hash helper; createGuard stays out of reach
];
const BAD_NODE = /^(node:)?(fs|fs\/promises|child_process|net|http|https|worker_threads|vm|cluster|dgram|os|module|process)$/;

function* walk(dir) {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules') continue;
    const p = path.join(dir, n), st = statSync(p);
    if (st.isDirectory()) yield* walk(p); else if (/\.m?js$/.test(n) && !/\.test\.m?js$/.test(n)) yield p;
  }
}

export function scanPackSource(dir) {
  const errors = [];
  const root = path.resolve(dir);
  for (const f of walk(root)) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, '$1');
    if (/\beval\s*\(|\bnew\s+Function\s*\(|\bprocess\s*\.\s*(env|binding|dlopen)|\bglobalThis\s*\.\s*process/.test(src)) errors.push(`${rel}: uses eval, Function or process access`);
    if (/\bimport\s*\(\s*[^'"\s]/.test(src)) errors.push(`${rel}: dynamic import with a computed specifier`);
    const specs = [...src.matchAll(/(?:\bimport|\bexport)\s*(?:([\w*${},\s]+?)\s*from\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)];
    for (const m of specs) {
      const clause = m[1] || '', spec = m[2] || m[3];
      if (!spec.startsWith('.')) { if (BAD_NODE.test(spec)) errors.push(`${rel}: imports ${spec}`); continue; }
      const abs = path.resolve(path.dirname(f), spec);
      if (abs === root || abs.startsWith(root + path.sep)) continue;
      const inCore = path.relative(CORE_DIR, abs).split(path.sep).join('/');
      const ok = !inCore.startsWith('..') && ALLOWED_CORE.some(a => a.file ? inCore === a.file : inCore.startsWith(a.dir));
      const rule = ok && ALLOWED_CORE.find(a => a.file === inCore);
      const names = clause.replace(/[{}]/g, '').split(',').map(x => x.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      if (!ok || (rule && rule.names && (!names.length || names.some(n => !rule.names.includes(n))))) errors.push(`${rel}: imports ${spec}, outside the pack and the allowed core helpers (US-21-R06)`);
    }
  }
  return errors;
}
