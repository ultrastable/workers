// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Probe definitions are data. Kinds: {kind:'http', url, status?, contains?[], version?:true} and {kind:'db', sql, expect:'>0'|'=3'|...}.
// Any probe may carry `revert: false`: it still runs and is recorded, but its failure does not revert a deploy (US-05-R09).
function cmp(n, expect) {
  const m = /^\s*(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(expect ?? '');
  if (!m) return false;
  const v = Number(m[2]);
  return { '>=': n >= v, '<=': n <= v, '>': n > v, '<': n < v, '=': n === v }[m[1]];
}

export const probeName = (d) => d.name || `${d.kind}:${d.url || d.sql}`.slice(0, 120);

export async function runProbes(defs, { db, fetch }, { version } = {}) {
  const out = [];
  for (const d of defs) {
    const name = probeName(d);
    try {
      if (d.kind === 'http') {
        const res = await fetch(d.url, { method: 'GET' });
        const text = await res.text();
        const want = d.status ?? 200;
        const miss = (d.contains || []).filter(s => !text.includes(s));
        const verBad = d.version && version != null && !text.includes(String(version));
        const ok = res.status === want && !miss.length && !verBad;
        out.push({ probe: name, ok, detail: ok ? `status ${res.status}` : `status ${res.status} (want ${want})${miss.length ? '; missing ' + miss.join('|') : ''}${verBad ? '; version not reported' : ''}` });
      } else if (d.kind === 'db') {
        const row = await db.prepare(d.sql).first();
        const n = Number(row && Object.values(row)[0]);
        out.push({ probe: name, ok: cmp(n, d.expect), detail: `value ${n} expect ${d.expect}` });
      } else out.push({ probe: name, ok: false, detail: 'unknown probe kind' });
    } catch (e) { out.push({ probe: name, ok: false, detail: 'error: ' + (e && e.message) }); }
  }
  return out;
}
