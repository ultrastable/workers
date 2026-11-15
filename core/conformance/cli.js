// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The conformance suite runner (US-SPEC-00).
//   node core/conformance/cli.js --spec-dir ../spec/specs --write        regenerate core/conformance/manifest.json
//   node core/conformance/cli.js [--spec-dir ../spec/specs] --check      verify the manifest against the tree (exit 1 on a false claim)
//   node core/conformance/cli.js --declare                               print the level, versions and deviation list (US-00-T01)
//   node core/conformance/cli.js --run [L1|L2|L3]                        run the test files that prove a level (US-00-T02)
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildManifest, check, declaration, testFiles } from './index.js';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const MANIFEST = path.join(ROOT, 'core/conformance/manifest.json');
const SKIP = new Set(['node_modules', '.git', '.wrangler', 'dist', '__pycache__']);

export function readSpecs(dir) {
  return readdirSync(dir).filter(f => /^US-SPEC-\d\d.*\.md$/.test(f)).sort().map(f => ({ file: f, text: readFileSync(path.join(dir, f), 'utf8') }));
}
export function readTests(root = ROOT) {
  const out = [];
  const walk = d => { for (const n of readdirSync(d).sort()) { if (SKIP.has(n)) continue; const p = path.join(d, n); const s = statSync(p); if (s.isDirectory()) walk(p); else if (/\.test\.(js|mjs)$/.test(n)) out.push({ path: path.relative(root, p).split(path.sep).join('/'), text: readFileSync(p, 'utf8') }); } };
  walk(root);
  return out;
}
export function readNamedFiles(manifest, root = ROOT) {
  const files = {};
  for (const f of new Set(manifest.requirements.flatMap(r => (r.tests || []).map(t => t.file)))) { const p = path.join(root, f); if (existsSync(p)) files[f] = readFileSync(p, 'utf8'); }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const has = n => process.argv.includes(n);
  const arg = n => { const i = process.argv.indexOf(n); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null; };
  const specDir = arg('--spec-dir');
  if (has('--write')) {
    if (!specDir) { console.error('--write needs --spec-dir'); process.exit(2); }
    const prev = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
    const reasons = Object.fromEntries((prev.requirements || []).filter(r => r.status === 'deviation' && r.reason && !/^no test in this repository/.test(r.reason)).map(r => [r.id, r.reason]));
    const m = buildManifest({ specs: readSpecs(specDir), tests: readTests(), declared: arg('--level') || prev.declared_level || 'L1', reasons, generated_at: new Date().toISOString().slice(0, 10) });
    writeFileSync(MANIFEST, JSON.stringify(m, null, 1) + '\n');
    const d = declaration(m);
    console.log(`wrote ${path.relative(ROOT, MANIFEST)}: ${m.requirements.length} requirements, level ${d.level} with ${d.deviations.length} deviations`);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  if (has('--declare')) console.log(JSON.stringify(declaration(manifest), null, 1));
  if (has('--check')) {
    const r = check(manifest, { files: readNamedFiles(manifest), specs: specDir ? readSpecs(specDir) : null, tests: readTests() });
    console.log(`${r.problems.length} problem(s), ${r.stale.length} deviation(s) a test now cites`);
    for (const p of r.problems) console.log('  ' + p);
    if (!r.ok) process.exit(1);
  }
  if (has('--run')) {
    const files = testFiles(manifest, arg('--run') || manifest.declared_level);
    const r = spawnSync(process.execPath, ['--test', '--no-warnings', ...files], { cwd: ROOT, stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
}
