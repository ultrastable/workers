// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The access preflight as a command, for CI and for any loop that is not the Worker tick.
//   node core/access/cli.mjs --config access.json [--out access-report.json]
// config: { needs: [{ capability, subject, require?: 'present' }], tokens?, github_sample_repos?, ttl_minutes?,
//           ask_phrases?: [{ pattern, capability, subject }], lint_paths?: [file or directory] }
// Exit 1 when (a) a need marked require:'present' is not present, or (b) a file under lint_paths contains an ask phrase for a
// capability the probe shows present or unproven missing (text that asks a person for what exists, or for what was never
// tried on every route). Probe results and every route's detail are printed; secrets are never read, only presence.
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeDb } from '../_shared/testdb.js';
import { probeAll } from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };

export function walk(p, out = []) {
  if (!existsSync(p)) return out;
  if (statSync(p).isFile()) { out.push(p); return out; }
  for (const f of readdirSync(p)) { if (f === 'node_modules' || f === '.git') continue; walk(path.join(p, f), out); }
  return out;
}

/** Pure: which ask phrases in which files contradict the probed state. */
export function lintAsks(files, phrases, states) {
  const bad = [];
  for (const f of files) {
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const ph of phrases || []) {
      const st = states.find(s => s.capability === ph.capability && s.subject === ph.subject);
      if (!st || st.status === 'missing') continue; // asking is allowed only when every route proved it missing
      const m = new RegExp(ph.pattern, 'i').exec(text);
      if (m) bad.push({ file: f, text: m[0].slice(0, 120), capability: ph.capability, subject: ph.subject, state: st.status });
    }
  }
  return bad;
}

export async function main() {
  const cfgPath = arg('--config');
  if (!cfgPath) { console.error('usage: cli.mjs --config access.json [--out report.json]'); return 2; }
  const config = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const db = makeDb([path.join(HERE, 'migrations/')]);
  const states = await probeAll({ db, now: () => Date.now(), fetch: globalThis.fetch, env: process.env, config }, config.needs || []);
  const failures = [];
  for (const n of config.needs || []) {
    const s = states.find(x => x.capability === n.capability && x.subject === n.subject);
    if (n.require === 'present' && s.status !== 'present') failures.push({ kind: 'required_not_present', capability: n.capability, subject: n.subject, status: s.status, routes: s.routes });
  }
  const root = path.dirname(path.resolve(cfgPath));
  const files = (config.lint_paths || []).flatMap(p => walk(path.resolve(root, p)));
  for (const b of lintAsks(files, config.ask_phrases, states)) failures.push({ kind: 'ask_for_granted_capability', ...b });
  const report = { at: new Date().toISOString(), states: states.map(s => ({ capability: s.capability, subject: s.subject, status: s.status, routes: s.routes })), failures };
  if (arg('--out')) writeFileSync(arg('--out'), JSON.stringify(report, null, 2));
  for (const s of report.states) { console.log(`${s.status.padEnd(8)} ${s.capability} ${s.subject}`); for (const r of s.routes) console.log(`           ${r.route}: ${r.outcome} - ${r.detail}`); }
  for (const f of failures) console.error(`FAIL ${f.kind}: ${JSON.stringify(f)}`);
  return failures.length ? 1 : 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(c => process.exit(c), e => { console.error(e); process.exit(2); });
