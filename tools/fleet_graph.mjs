// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Blast radius of a change, from the command line. Builds the import graph of the working tree (two edge sources: this scan, and an
// optional declared-edges JSON file) with core/graph, then prints what depends on the changed files.
//   node tools/fleet_graph.mjs --changed core/router/router.js,core/claims/index.js [--declared ops/edges.json] [--root .]
//   node tools/fleet_graph.mjs --git-diff origin/main            (changed = git diff --name-only)
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ingest, declare, blastRadius } from '../core/graph/index.js';

const SKIP = new Set(['node_modules', '.git', '__pycache__']);
export function scanFiles(root) {
  const out = [];
  const walk = d => { for (const n of readdirSync(d)) { if (SKIP.has(n)) continue; const p = path.join(d, n), st = statSync(p);
    if (st.isDirectory()) walk(p); else if (/\.(m?js)$/.test(n)) out.push({ path: path.relative(root, p).split(path.sep).join('/'), text: readFileSync(p, 'utf8') }); } };
  walk(root); return out;
}
export function graphDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(fileURLToPath(new URL('../core/graph/migrations/0001_graph.sql', import.meta.url)), 'utf8'));
  return { prepare(sql) { const st = raw.prepare(sql); let a = []; const o = { bind(...x) { a = x; return o; },
    async all() { return { results: st.all(...a).map(r => ({ ...r })) }; }, async first() { const r = st.get(...a); return r ? { ...r } : null; },
    async run() { const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; } }; return o; } };
}
export async function analyse({ root, changed, declared = [] }) {
  const ctx = { db: graphDb(), now: () => 0, sources: [{ name: 'scan', list: async () => scanFiles(root) }] };
  const report = await ingest(ctx);
  for (const [s, d] of declared) await declare(ctx, s, d);
  return { sources: report, ...(await blastRadius(ctx, changed)) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
  const root = path.resolve(arg('--root') || '.');
  let changed = (arg('--changed') || '').split(',').filter(Boolean);
  if (arg('--git-diff')) changed = execFileSync('git', ['diff', '--name-only', arg('--git-diff')], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const dp = arg('--declared'); const declared = dp && existsSync(dp) ? JSON.parse(readFileSync(dp, 'utf8')) : [];
  const r = await analyse({ root, changed, declared });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.sources.every(s => s.ok) ? 0 : 1);
}
