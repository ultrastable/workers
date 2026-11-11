// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Static check for US-21-R03 / T21-7: no core or adapter module imports a pack module.
// A pack module is any file inside a directory that holds a pack.json. The pack host (core/packs/*.js) is not a pack.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', '__pycache__', 'test-fixtures']);
const IMPORT_RE = /(?:\bimport\s+(?:[^'"()]*?\bfrom\s+)?|\bexport\s+[^'"()]*?\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function* walk(p) {
  const st = statSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isFile()) { yield p; return; }
  for (const n of readdirSync(p)) if (!SKIP.has(n)) yield* walk(path.join(p, n));
}

function inPackDir(file, root) {
  for (let d = path.dirname(file); d.startsWith(root); d = path.dirname(d)) {
    if (existsSync(path.join(d, 'pack.json'))) return d;
    if (d === root) break;
  }
  return null;
}

// Returns [] when clean; throws an Error listing every offender otherwise.
export function assertCoreImportsNoPacks(rootDir, dirs = ['core', 'adapters']) {
  const root = path.resolve(rootDir);
  const offenders = [];
  for (const d of dirs) for (const f of walk(path.join(root, d))) {
    if (!/\.m?js$/.test(f) || inPackDir(f, root)) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      if (inPackDir(path.resolve(path.dirname(f), spec), root)) offenders.push(`${path.relative(root, f)} imports pack module ${spec}`);
    }
  }
  if (offenders.length) throw new Error('core code imports pack modules (US-21-R03):\n' + offenders.join('\n'));
  return offenders;
}
