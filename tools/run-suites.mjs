// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Run the repository's test suites from one list (ops/suites.json: [{name, cmd, cwd?}]), all of them even if one fails, then print
// a table and exit non-zero if any failed. A suite that cannot start counts as failed with the reason (never skipped silently).
//   node tools/run-suites.mjs [--list ops/suites.json] [--only name,name]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function runSuite(s, spawn = spawnSync) {
  const t0 = Date.now();
  const r = spawn('sh', ['-c', s.cmd], { cwd: s.cwd || '.', encoding: 'utf8', timeout: s.timeout_ms || 600000 });
  const ok = r.status === 0 && !r.error;
  return { name: s.name, ok, code: r.status, ms: Date.now() - t0, reason: r.error ? String(r.error.message).slice(0, 120) : ok ? '' : String(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ').slice(0, 300) };
}
export function runAll(list, only = null, spawn = spawnSync) {
  return list.filter(s => !only || only.includes(s.name)).map(s => runSuite(s, spawn));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
  const list = JSON.parse(readFileSync(arg('--list') || 'ops/suites.json', 'utf8'));
  const res = runAll(list, arg('--only') ? arg('--only').split(',') : null);
  for (const r of res) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name.padEnd(24) + String(r.ms).padStart(7) + ' ms' + (r.reason ? '  ' + r.reason : ''));
  process.exit(res.every(r => r.ok) ? 0 : 1);
}
