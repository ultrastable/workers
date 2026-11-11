// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Calibration: probe every provider/rung with fixed probes, record results, steer away from a failing route and back.
// Ports: ctx = { db, now(), config, router }. A probe goes through router.call pinned to one provider, so the same
// path real work uses is the path measured. Rule: never switch off the last healthy route (no single point of failure).
const DEFAULTS = { fail_streak_off: 3, pass_streak_on: 2, max_latency_ms: 20000, owner_role: 'operations' };
const PROBES = [
  { name: 'echo-json', request: { messages: [{ role: 'user', content: 'Reply with exactly this JSON and nothing else: {"ok":true}' }], max_tokens: 32 },
    check: r => { try { return JSON.parse(String(r.text).trim().replace(/^```(json)?|```$/g, '')).ok === true; } catch { return false; } } },
  { name: 'nonempty', request: { messages: [{ role: 'user', content: 'Say OK.' }], max_tokens: 8 }, check: r => String(r.text || '').trim().length > 0 },
];
export const probes = PROBES.map(p => p.name);
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const nowMs = ctx => { const v = ctx.now(); return v instanceof Date ? v.getTime() : v; };

export async function probeOne(ctx, provider, rung) {
  const out = [];
  for (const p of PROBES) {
    const t0 = nowMs(ctx);
    let ok = false, detail = '';
    try {
      const r = await ctx.router.call({ role: 'calibration', kind: 'calibration', rung, providers: [provider], ...p.request });
      ok = !!r.ok && p.check(r); detail = r.ok ? (ok ? 'ok' : 'check_failed') : String(r.refusal || 'failed');
    } catch (e) { detail = String(e?.message || e).slice(0, 200); }
    const ms = nowMs(ctx) - t0;
    if (ok && ms > (ctx.config?.max_latency_ms ?? DEFAULTS.max_latency_ms)) { ok = false; detail = 'too_slow'; }
    await ctx.db.prepare('INSERT INTO router_calibration (at, provider, rung, probe, ok, latency_ms, detail) VALUES (?,?,?,?,?,?,?)')
      .bind(iso(nowMs(ctx)), provider, rung, p.name, ok ? 1 : 0, ms, detail).run();
    out.push({ probe: p.name, ok });
  }
  return out;
}

/** Probe all providers at all rungs; then update switches. Returns { switched_off, switched_on, healthy }. */
export async function calibrate(ctx, { providers, rungs }) {
  const c = { ...DEFAULTS, ...(ctx.config || {}) };
  const names = Object.keys(providers);
  // A switched-off provider is probed too (else it could never recover): lift its switch for the probe, re-engage below if still failing.
  const wasOff = new Set((await ctx.db.prepare("SELECT name FROM router_switches WHERE is_on = 1 AND name LIKE 'provider:%'").all()).results.map(r => r.name.slice(9)));
  for (const n of names) {
    if (wasOff.has(n)) await ctx.router.setSwitch('provider:' + n, false, 'calibration: probing');
    for (const r of rungs) if (providers[n].models?.[r]) await probeOne(ctx, n, r);
  }
  const state = {};
  for (const n of names) {
    const rows = (await ctx.db.prepare('SELECT ok FROM (SELECT id, ok FROM router_calibration WHERE provider = ? ORDER BY id DESC LIMIT ?) ORDER BY id DESC').bind(n, Math.max(c.fail_streak_off, c.pass_streak_on) * PROBES.length).all()).results;
    const recent = rows.map(x => x.ok);
    state[n] = { failing: recent.length >= c.fail_streak_off && recent.slice(0, c.fail_streak_off).every(v => v === 0), passing: recent.slice(0, c.pass_streak_on * PROBES.length).every(v => v === 1) };
  }
  const healthy = names.filter(n => !state[n].failing);
  const off = [], on = [];
  for (const n of names) {
    if (state[n].failing && healthy.length > 0) {
      await ctx.router.setSwitch('provider:' + n, true, 'calibration: failing probes'); off.push(n);
      await ctx.db.prepare("INSERT OR IGNORE INTO items (id,title,kind,owner_role,done_check,closing_probe,priority,status) VALUES (?,?,'fix',?,?,?,55,'open')")
        .bind('CAL-' + n, 'Provider ' + n + ' fails calibration probes', c.owner_role, 'probes fail for ' + n, 'two consecutive calibration runs pass for ' + n).run();
    } else if (wasOff.has(n) && !state[n].passing) {
      await ctx.router.setSwitch('provider:' + n, true, 'calibration: still failing'); off.push(n);
    } else if (state[n].passing) {
      await ctx.router.setSwitch('provider:' + n, false, 'calibration: recovered'); on.push(n);
      await ctx.db.prepare("UPDATE items SET status='done', disposition='probes pass again', updated_at=datetime('now') WHERE id=? AND status='open'").bind('CAL-' + n).run();
    }
  }
  return { switched_off: off, switched_on: on, healthy };
}
