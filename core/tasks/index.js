// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Task runner and owner-step watch. A task is a unit of deferred work (kind + payload) in the database; handlers are
// registered per kind as an ORDERED LIST of routes (no single route): the first that succeeds wins, a thrown error tries the next,
// and a task whose routes all fail is retried with backoff, then marked failed and filed as a work item (never dropped).
// Owner-step watch: gate cards open longer than owner_step_hours get one escalation item, and closing probes are re-checked.
// Ports: ctx = { db, now(), config, handlers: { kind: [fn(payload, ctx)] }, probe?(card) -> bool }.
const DEFAULTS = { max_attempts: 4, backoff_minutes: 10, batch: 10, owner_step_hours: 24, escalation_role: 'project-manager' };
const nowMs = ctx => { const v = ctx.now(); return v instanceof Date ? v.getTime() : v; };
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
export const cfg = ctx => ({ ...DEFAULTS, ...(ctx.config || {}) });

export async function enqueue(ctx, kind, payload = {}, { delayMinutes = 0 } = {}) {
  const t = nowMs(ctx);
  const r = await ctx.db.prepare('INSERT INTO tasks_queue (kind, payload_json, next_at, created_at, updated_at) VALUES (?,?,?,?,?)').bind(kind, JSON.stringify(payload), iso(t + delayMinutes * 60000), iso(t), iso(t)).run();
  return r.meta.last_row_id;
}
export async function runDue(ctx) {
  const c = cfg(ctx), t = nowMs(ctx), res = { done: 0, retried: 0, failed: 0 };
  const rows = (await ctx.db.prepare("SELECT * FROM tasks_queue WHERE status='pending' AND next_at <= ? ORDER BY id LIMIT ?").bind(iso(t), c.batch).all()).results;
  for (const row of rows) {
    const routes = (ctx.handlers || {})[row.kind] || [];
    let ok = false, err = routes.length ? '' : 'no_handler', used = null;
    for (let i = 0; i < routes.length && !ok; i++) {
      try { await routes[i](JSON.parse(row.payload_json || '{}'), ctx); ok = true; used = 'route-' + i; } catch (e) { err = String(e?.message || e).slice(0, 300); }
    }
    const attempts = row.attempts + 1;
    if (ok) { await ctx.db.prepare("UPDATE tasks_queue SET status='done', attempts=?, handler=?, last_error=NULL, updated_at=? WHERE id=?").bind(attempts, used, iso(t), row.id).run(); res.done++; }
    else if (attempts >= c.max_attempts) {
      await ctx.db.prepare("UPDATE tasks_queue SET status='failed', attempts=?, last_error=?, updated_at=? WHERE id=?").bind(attempts, err, iso(t), row.id).run();
      await ctx.db.prepare("INSERT OR IGNORE INTO items (id,title,kind,owner_role,done_check,closing_probe,priority,status) VALUES (?,?,'fix','operations',?,?,50,'open')")
        .bind('TASK-' + row.id, 'Task ' + row.kind + ' failed ' + attempts + ' times: ' + err.slice(0, 80), 'task ' + row.id + ' completes or is cancelled with a disposition', 'tasks_queue row ' + row.id + ' status done').run();
      res.failed++;
    } else {
      await ctx.db.prepare("UPDATE tasks_queue SET attempts=?, last_error=?, next_at=?, updated_at=? WHERE id=?").bind(attempts, err, iso(t + c.backoff_minutes * 60000 * attempts), iso(t), row.id).run(); res.retried++;
    }
  }
  return res;
}
/** Re-probe open gate cards; escalate (once) any open longer than owner_step_hours. */
export async function watchOwnerSteps(ctx) {
  const c = cfg(ctx), t = nowMs(ctx), out = { closed: 0, escalated: 0 };
  const cards = (await ctx.db.prepare("SELECT * FROM gate_cards WHERE status='open'").all()).results;
  for (const g of cards) {
    if (ctx.probe && await ctx.probe(g)) { await ctx.db.prepare("UPDATE gate_cards SET status='closed', closed_at=? WHERE id=?").bind(iso(t), g.id).run(); out.closed++; continue; }
    await ctx.db.prepare('INSERT OR IGNORE INTO tasks_owner_steps (card_id, first_seen_ms) VALUES (?,?)').bind(g.id, t).run();
    const seen = await ctx.db.prepare('SELECT first_seen_ms FROM tasks_owner_steps WHERE card_id = ?').bind(g.id).first();
    const age = (t - Number(seen.first_seen_ms)) / 3600000;
    if (age >= c.owner_step_hours) {
      const r = await ctx.db.prepare("INSERT OR IGNORE INTO items (id,title,kind,owner_role,done_check,closing_probe,priority,status) VALUES (?,?,'work',?,?,?,40,'open')")
        .bind('OWNER-' + g.id, 'Owner step open ' + Math.round(age) + 'h: ' + g.what.slice(0, 80), c.escalation_role, 'gate card ' + g.id + ' closed', g.closing_probe).run();
      out.escalated += r.meta.changes;
    }
  }
  return out;
}
