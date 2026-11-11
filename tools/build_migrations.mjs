// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Builds adapters/cloudflare/migrations/: every module's migrations concatenated in dependency order as
// NNNN_<module>_<name>.sql. The output is committed; core/org/migrations.test.js fails if it drifts.
// Usage: node tools/build_migrations.mjs [--config org-config.json] [--check]
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { moduleList } from '../core/org/modules.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const OUT_DIR = path.join(ROOT, 'adapters/cloudflare/migrations');

export function buildMigrations({ root = ROOT, config = {} } = {}) {
  const out = [];
  let n = 0;
  for (const m of moduleList(config)) {
    const dir = path.join(root, m.dir);
    if (!existsSync(dir)) throw new Error(`module ${m.id}: no migrations directory ${m.dir}`);
    for (const f of readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
      const name = f.replace(/\.sql$/, '').replace(/^\d+_/, '');
      const file = `${String(++n).padStart(4, '0')}_${m.id}_${name}.sql`;
      out.push({ file, source: `${m.dir}/${f}`, sql: readFileSync(path.join(dir, f), 'utf8') });
    }
  }
  return out;
}

export function writeMigrations(files, outDir = OUT_DIR) {
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir).filter(x => x.endsWith('.sql'))) rmSync(path.join(outDir, f));
  for (const f of files) writeFileSync(path.join(outDir, f.file), f.sql);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ci = process.argv.indexOf('--config');
  const config = ci > 0 ? JSON.parse(readFileSync(process.argv[ci + 1], 'utf8')) : {};
  const files = buildMigrations({ config });
  if (process.argv.includes('--check')) {
    const have = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter(x => x.endsWith('.sql')) : [];
    const same = have.length === files.length && files.every(f => have.includes(f.file) && readFileSync(path.join(OUT_DIR, f.file), 'utf8') === f.sql);
    console.log(same ? `migrations up to date (${files.length} files)` : 'migrations drifted: run node tools/build_migrations.mjs');
    process.exit(same ? 0 : 1);
  }
  writeMigrations(files);
  console.log(`wrote ${files.length} migration files to adapters/cloudflare/migrations`);
}
