// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Parity smoke: run one contract (docs/cutover/parity-contract.json) against a "from" and a "to" deployment and report, per check,
// whether each answers as the contract says and whether they agree. Read-only (GET/HEAD). Two routes per side: a list of base URLs,
// the first that answers is used. Exit 0 only when every check passes on BOTH sides (the cutover gate).
//   node tools/parity_smoke.mjs --from https://a,https://b --to https://c,https://d [--contract docs/cutover/parity-contract.json]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function hit(bases, check, fetchFn) {
  const errs = [];
  for (const b of bases) {
    try {
      const r = await fetchFn(b.replace(/\/$/, '') + check.path, { method: 'GET', headers: check.headers || {} });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not JSON: fine */ }
      const keys = json && typeof json === 'object' ? Object.keys(json).sort() : [];
      const missing = (check.json_keys || []).filter(k => !keys.includes(k));
      const statusOk = (check.status || [200]).includes(r.status);
      const containsOk = !check.contains || text.includes(check.contains);
      return { ok: statusOk && !missing.length && containsOk, status: r.status, keys, base: b, detail: [statusOk ? '' : 'status ' + r.status, missing.length ? 'missing keys ' + missing.join(',') : '', containsOk ? '' : 'text missing'].filter(Boolean).join('; ') };
    } catch (e) { errs.push(b + ': ' + String(e.message).slice(0, 80)); }
  }
  return { ok: false, status: 0, keys: [], base: null, detail: 'no route answered: ' + errs.join(' | ') };
}

export async function runParity({ from, to, contract, fetchFn = fetch }) {
  const rows = [];
  for (const c of contract.checks) {
    const [a, b] = [await hit(from, c, fetchFn), await hit(to, c, fetchFn)];
    const same = a.status === b.status && (!c.compare_keys || JSON.stringify(a.keys) === JSON.stringify(b.keys));
    rows.push({ id: c.id, unit: c.unit, from: a, to: b, agree: same, pass: a.ok && b.ok && same });
  }
  return { pass: rows.every(r => r.pass), rows };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
  const contract = JSON.parse(readFileSync(arg('--contract') || 'docs/cutover/parity-contract.json', 'utf8'));
  const res = await runParity({ from: (arg('--from') || '').split(',').filter(Boolean), to: (arg('--to') || '').split(',').filter(Boolean), contract });
  for (const r of res.rows) console.log((r.pass ? 'PASS ' : 'FAIL ') + r.id.padEnd(18) + r.unit.padEnd(14) + 'from ' + r.from.status + ' to ' + r.to.status + (r.pass ? '' : '  ' + [r.from.detail, r.to.detail].filter(Boolean).join(' / ')));
  process.exit(res.pass ? 0 : 1);
}
