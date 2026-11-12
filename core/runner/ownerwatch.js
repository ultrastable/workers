// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Owner-step watch and probe cadence (US-SPEC-11). An owner step is a gate card (core/migrations gate_cards): an action only a person
// can take. The watch re-probes each open card on a cadence (not every tick), closes it the moment its closing probe passes,
// and escalates it, once per tier, when it stays open: tier 1 after owner_step_hours (an item for the escalation role), tier 2 after
// twice that (the same item is raised to top priority). Probe kinds in gate_cards.closing_probe:
//   env:<NAME>      the secret or variable is present (ports: ctx.env, presence only)
//   item_done:<id>  the item reached a closed status
//   http:<url>      GET answers 2xx (port: ctx.fetch)
//   manual          never passes by itself; ctx.probe(card) may decide
// ctx.probe(card) -> bool|undefined is consulted first and wins when it returns a boolean.
// Probe cadence: runCadence(ctx) runs named probes ({ name, every_minutes, run() -> bool }), tracks a fail streak and files one
// item per failing probe once the streak reaches fail_streak_item.
const DEFAULTS = { owner_step_hours: 24, escalation_role: 'project-manager', probe_every_minutes: 30, fail_streak_item: 3, closed_statuses: ['done', 'superseded', 'cancelled'] };
const cfg = ctx => ({ ...DEFAULTS, ...(ctx.config || {}) });
const nowMs = ctx => { const v = ctx.now(); return v instanceof Date ? v.getTime() : v; };
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();

/** Evaluate one card's closing probe. Never throws: an error is a failed probe. */
export async function probeCard(ctx, card) {
  const c = cfg(ctx);
  try {
    if (ctx.probe) { const v = await ctx.probe(card); if (typeof v === 'boolean') return v; }
    const [kind, ...rest] = String(card.closing_probe || 'manual').split(':'), arg = rest.join(':');
    if (kind === 'env') return !!(ctx.env || {})[arg];
    if (kind === 'item_done') {
      const it = await first(ctx.db, 'SELECT status FROM items WHERE id = ?', arg);
      return !!it && c.closed_statuses.includes(it.status);
    }
    if (kind === 'http') { const r = await ctx.fetch(arg); return r.status >= 200 && r.status < 300; }
    return false;
  } catch { return false; }
}

export async function watchOwnerSteps(ctx) {
  const c = cfg(ctx), t = nowMs(ctx), out = { probed: 0, closed: 0, escalated: 0, raised: 0 };
  for (const g of await all(ctx.db, "SELECT * FROM gate_cards WHERE status='open'")) {
    await run(ctx.db, 'INSERT OR IGNORE INTO runner_ownerwatch (card_id, first_seen_ms) VALUES (?,?)', g.id, t);
    const w = await first(ctx.db, 'SELECT * FROM runner_ownerwatch WHERE card_id = ?', g.id);
    if (w.last_probe_ms != null && t - Number(w.last_probe_ms) < c.probe_every_minutes * 60000) continue; // not due
    out.probed++;
    if (await probeCard(ctx, g)) {
      await run(ctx.db, "UPDATE gate_cards SET status='closed', closed_at=? WHERE id=?", iso(t), g.id);
      await run(ctx.db, "UPDATE items SET status='done', disposition='closed: probe passed', updated_at=datetime('now') WHERE id=? AND status='open'", 'OWNER-' + g.id);
      out.closed++; continue;
    }
    await run(ctx.db, 'UPDATE runner_ownerwatch SET last_probe_ms=?, probes=probes+1 WHERE card_id=?', t, g.id);
    const age = (t - Number(w.first_seen_ms)) / 3600000, id = 'OWNER-' + g.id;
    if (age >= c.owner_step_hours && Number(w.escalated) < 1) {
      const r = await run(ctx.db, "INSERT OR IGNORE INTO items (id,title,kind,owner_role,done_check,closing_probe,priority,status) VALUES (?,?,'work',?,?,?,40,'open')",
        id, 'Owner step open ' + Math.round(age) + 'h: ' + String(g.what).slice(0, 80), c.escalation_role, 'gate card ' + g.id + ' closed', g.closing_probe);
      await run(ctx.db, 'UPDATE runner_ownerwatch SET escalated=1 WHERE card_id=?', g.id);
      out.escalated += r.meta.changes;
    }
    if (age >= 2 * c.owner_step_hours && Number(w.escalated) < 2) {
      await run(ctx.db, "UPDATE items SET priority=95, updated_at=datetime('now') WHERE id=?", id);
      await run(ctx.db, 'UPDATE runner_ownerwatch SET escalated=2 WHERE card_id=?', g.id);
      out.raised++;
    }
  }
  return out;
}

/** Run each named probe that is due; a fail streak at the threshold files one item (OPS-PROBE-<name>), a pass closes it. */
export async function runCadence(ctx, probes) {
  const c = cfg(ctx), t = nowMs(ctx), out = { ran: 0, failed: 0, filed: 0, recovered: 0 };
  for (const p of probes) {
    const s = await first(ctx.db, 'SELECT * FROM runner_probe_cadence WHERE name = ?', p.name);
    if (s && s.last_run_ms != null && t - Number(s.last_run_ms) < p.every_minutes * 60000) continue;
    let ok = false; try { ok = !!(await p.run()); } catch { ok = false; }
    const streak = ok ? 0 : (s ? Number(s.fail_streak) : 0) + 1;
    await run(ctx.db, `INSERT INTO runner_probe_cadence (name, last_run_ms, last_ok, fail_streak, runs) VALUES (?,?,?,?,1)
      ON CONFLICT(name) DO UPDATE SET last_run_ms=excluded.last_run_ms, last_ok=excluded.last_ok, fail_streak=excluded.fail_streak, runs=runs+1`, p.name, t, ok ? 1 : 0, streak);
    out.ran++;
    const id = 'OPS-PROBE-' + p.name;
    if (!ok) {
      out.failed++;
      if (streak >= c.fail_streak_item) out.filed += (await run(ctx.db, "INSERT OR IGNORE INTO items (id,title,kind,owner_role,done_check,closing_probe,priority,status) VALUES (?,?,'fix','operations',?,?,70,'open')",
        id, 'Probe ' + p.name + ' failed ' + streak + ' times in a row', 'probe ' + p.name + ' passes', 'runner_probe_cadence ' + p.name + ' last_ok = 1')).meta.changes;
    } else if (s && Number(s.fail_streak) >= c.fail_streak_item) {
      await run(ctx.db, "UPDATE items SET status='done', disposition='closed: probe passes again', updated_at=datetime('now') WHERE id=? AND status='open'", id);
      out.recovered++;
    }
  }
  return out;
}
