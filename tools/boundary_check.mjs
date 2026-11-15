// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Boundary check (US-SPEC-10 s7, US-10-R11). The manifest tools/boundary.json classifies every component (a directory
// directly under one of its `roots`) as core, app or private, with a role, and lists core scripts, workflows and tables.
// The check enumerates the live components and reports: a live component absent from the manifest, a manifest component
// that is not live, an unknown class, a missing role, a listed path that does not exist, a listed table no migration
// creates. Exit 1 on any violation, so a new component cannot merge without a decision on which side it lies.
//   node tools/boundary_check.mjs [--root .] [--manifest tools/boundary.json] [--json]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CLASSES = ['core', 'app', 'private'];
const SKIP = new Set(['node_modules', '__pycache__']);

/** Live components: directories under each root that hold at least one file (at any depth), sorted. */
export function liveComponents(root, roots) {
  const holdsFile = dir => readdirSync(dir, { withFileTypes: true }).some(e => !SKIP.has(e.name) && !e.name.startsWith('.') && (e.isFile() || (e.isDirectory() && holdsFile(path.join(dir, e.name)))));
  const out = [];
  for (const r of roots) {
    const base = path.join(root, r);
    if (!existsSync(base)) continue;
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue;
      if (holdsFile(path.join(base, e.name))) out.push(`${r}/${e.name}`);
    }
  }
  return out.sort();
}

/** Every table a migration under the root creates. */
export function createdTables(root, roots) {
  const tables = new Set();
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.sql') && path.basename(dir) === 'migrations') for (const m of readFileSync(p, 'utf8').matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/gi)) tables.add(m[1]);
    }
  };
  for (const r of roots) if (existsSync(path.join(root, r))) walk(path.join(root, r));
  return tables;
}

export function checkBoundary(root, manifest) {
  const violations = [], roots = manifest.roots || [], listed = manifest.components || {};
  if (!roots.length) violations.push('the manifest names no roots');
  const live = liveComponents(root, roots);
  for (const c of live) if (!listed[c]) violations.push(`unclassified live component: ${c} (add it to the manifest as core, app or private, with a role)`);
  for (const [c, v] of Object.entries(listed)) {
    if (!live.includes(c)) violations.push(`classified component is not live: ${c} (remove it from the manifest, or restore it)`);
    if (!CLASSES.includes(v?.class)) violations.push(`unknown class for ${c}: ${v?.class}`);
    if (!String(v?.role || '').trim()) violations.push(`component ${c} has no role text`);
    if (!roots.some(r => c.startsWith(r + '/'))) violations.push(`component ${c} is outside the manifest roots`);
  }
  for (const f of [...(manifest.core_scripts || []), ...(manifest.core_workflows || [])]) {
    if (!existsSync(path.join(root, f)) || !statSync(path.join(root, f)).isFile()) violations.push(`listed path is missing: ${f}`);
  }
  if ((manifest.core_tables || []).length) {
    const tables = createdTables(root, roots);
    for (const t of manifest.core_tables) if (!tables.has(t)) violations.push(`listed table is created by no migration: ${t}`);
  }
  const counts = Object.fromEntries(CLASSES.map(k => [k, Object.values(listed).filter(v => v?.class === k).length]));
  return { ok: violations.length === 0, live: live.length, classified: Object.keys(listed).length, counts, violations };
}

export function main(argv, log = console.log) {
  const get = k => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  const root = path.resolve(get('--root') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const file = get('--manifest') || path.join(root, 'tools', 'boundary.json');
  let manifest;
  try { manifest = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { log(`boundary: cannot read the manifest ${file}: ${e.message}`); return 1; }
  const r = checkBoundary(root, manifest);
  if (argv.includes('--json')) log(JSON.stringify(r, null, 2));
  else {
    for (const v of r.violations) log(`boundary: ${v}`);
    log(`boundary: ${r.live} live component(s), ${r.classified} classified (core ${r.counts.core}, app ${r.counts.app}, private ${r.counts.private}), ${r.violations.length} violation(s)`);
  }
  return r.ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
