// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Pack loader (US-SPEC-21): find packs by scanning a directory, and apply a pack's own migrations on enable.
// A pack migration may only create or alter objects named `<id>_*` (R08); each file is applied once and its digest is kept.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { first, run, iso } from '../kernel/util.js';
import { sha256 } from './guard.js';
import { stripSql } from './sandbox.js';

// Split SQL text into statements on top-level semicolons (respects quoted strings and comments).
export function splitStatements(sql) {
  const out = []; let cur = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], n = sql[i + 1];
    if (c === "'") { let j = i + 1; while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1; cur += sql.slice(i, j + 1); i = j; }
    else if (c === '-' && n === '-') { while (i < sql.length && sql[i] !== '\n') i++; cur += '\n'; }
    else if (c === '/' && n === '*') { const j = sql.indexOf('*/', i + 2); i = j < 0 ? sql.length : j + 1; cur += ' '; }
    else if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const NAME = '([A-Za-z_]\\w*)';

// Returns a list of problems for one statement; empty means allowed.
export function checkMigrationStatement(stmt, packId) {
  const s = stripSql(stmt).trim();
  const own = `${packId}_`;
  if (/["`\[]/.test(s)) return ['quoted identifiers are not allowed'];
  const REF = '\\b(?:from|join|into|update|references|table|on)\\s+';
  if (new RegExp(`${REF}(?:(?:packs_|guard_|kernel_)\\w+|trust_ledger\\b|roles\\b)`, 'i').test(s)) return ['touches host tables'];
  let m;
  if ((m = s.match(new RegExp(`^create\\s+(?:unique\\s+)?(table|index|view)\\s+(?:if\\s+not\\s+exists\\s+)?${NAME}`, 'i')))) {
    const kind = m[1].toLowerCase(), obj = m[2].toLowerCase();
    if (kind === 'index') {
      const on = s.match(/\bon\s+([A-Za-z_]\w*)/i);
      return on && on[1].toLowerCase().startsWith(own) ? [] : [`index must be on a table named ${own}*`];
    }
    return obj.startsWith(own) ? [] : [`${kind} "${obj}" must be named ${own}*`];
  }
  if ((m = s.match(new RegExp(`^alter\\s+table\\s+${NAME}`, 'i')))) return m[1].toLowerCase().startsWith(own) ? [] : [`alter table "${m[1]}" must be named ${own}*`];
  if ((m = s.match(new RegExp(`^insert\\s+(?:or\\s+\\w+\\s+)?into\\s+${NAME}`, 'i')))) return m[1].toLowerCase().startsWith(own) ? [] : [`insert into "${m[1]}" must be named ${own}*`];
  return ['only CREATE TABLE/INDEX/VIEW, ALTER TABLE and INSERT on the pack own objects are allowed'];
}

// Read and check a pack's migration files. Returns { files: [{ file, sql, statements }], errors }.
export function readMigrations(manifest, dir) {
  const errors = [], files = [];
  const root = path.resolve(dir);
  for (const rel of manifest.migrations || []) {
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep) || !abs.endsWith('.sql')) { errors.push(`${rel}: must be a .sql file inside the pack directory`); continue; }
    if (!existsSync(abs)) { errors.push(`${rel}: file not found`); continue; }
    const sql = readFileSync(abs, 'utf8');
    const statements = splitStatements(sql);
    for (const st of statements) for (const p of checkMigrationStatement(st, manifest.id)) errors.push(`${rel}: ${p}: ${st.replace(/\s+/g, ' ').slice(0, 60)}`);
    files.push({ file: path.relative(root, abs).split(path.sep).join('/'), sql, statements });
  }
  return { files, errors };
}

// Apply once per file, in manifest order. A file already applied with a different digest is refused (edit a migration = add a new one).
export async function applyPackMigrations(db, manifest, dir, now = Date.now) {
  if (!(manifest.migrations || []).length) return { ok: true, applied: [], skipped: [] };
  if (!dir) return { ok: false, reason: 'source_dir_required_for_migrations', errors: [] };
  const { files, errors } = readMigrations(manifest, dir);
  if (errors.length) return { ok: false, reason: 'migration_refused', errors };
  const applied = [], skipped = [];
  for (const f of files) {
    const digest = await sha256(f.sql.replace(/\r\n/g, '\n'));
    const done = await first(db, `SELECT sha256 FROM packs_migrations WHERE pack_id = ? AND file = ?`, manifest.id, f.file);
    if (done) {
      if (done.sha256 !== digest) return { ok: false, reason: 'migration_changed', errors: [`${f.file} was applied with a different digest; add a new migration instead`], applied, skipped };
      skipped.push(f.file); continue;
    }
    try { for (const st of f.statements) await run(db, st); }
    catch (e) { return { ok: false, reason: 'migration_failed', errors: [`${f.file}: ${e.message}`], applied, skipped }; }
    await run(db, `INSERT INTO packs_migrations (pack_id, file, sha256, statements, applied_at) VALUES (?,?,?,?,?)`, manifest.id, f.file, digest, f.statements.length, iso(now()));
    applied.push(f.file);
  }
  return { ok: true, applied, skipped };
}

// Every immediate subdirectory of `root` that holds a pack.json is a pack. Unreadable manifests are reported, not thrown.
export function scanPackDirs(root) {
  const found = [], failed = [];
  if (!existsSync(root)) return { found, failed: [{ dir: root, errors: ['packs directory not found'] }] };
  for (const n of readdirSync(root).sort()) {
    const dir = path.join(root, n);
    if (!statSync(dir).isDirectory() || !existsSync(path.join(dir, 'pack.json'))) continue;
    try { found.push({ dir, manifest: JSON.parse(readFileSync(path.join(dir, 'pack.json'), 'utf8')) }); }
    catch (e) { failed.push({ dir, errors: [`pack.json: ${e.message}`] }); }
  }
  return { found, failed };
}
