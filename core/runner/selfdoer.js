// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The self-hosting doer driver (issue #13, docs/SELF-HOSTING.md section 4): feeds the specification backlog to the runner and
// keeps the runner inside hard spend caps. Opt-in: nothing here runs unless core/org is given config.selfdoer.enabled.
//  - seedBacklog(db, items, targets): one item per unfinished capability (tools/spec_backlog.py --json). An item is `ready`
//    only when a target map names the file (and optionally its test) it changes; otherwise it stays `blocked` until the map names one, so the runner never
//    starts a run it would refuse with no_target. Idempotent (INSERT OR IGNORE).
//  - spendSince / capGuard: model spend from router_calls against daily and monthly caps. Over a cap the runner step is skipped
//    and the tick says so; the router's own caps and kill switch stay in force underneath (this is the outer layer).
//  - guardSteps(steps, ctx): wraps runner steps with capGuard.
// Ports: db, now() ms, config { daily_usd, monthly_usd }. No network, no secrets.
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const clean = s => String(s ?? '').replace(/[\r\n;]+/g, ' ').trim();

export const AWAITING = 'awaiting target: name a file in the target map';

export async function seedBacklog(db, items = [], targets = {}) {
  const out = { seeded: 0, ready: 0, open: 0, existing: 0, promoted: 0 };
  for (const it of items) {
    if (!it || typeof it.id !== 'string' || !it.title) continue;
    const t = targets[it.id];
    const lines = [clean(it.done_check)];
    if (t?.target) lines.push(`spec: ${it.id}`, `target: ${clean(t.target)}`);
    if (t?.test) lines.push(`test: ${clean(t.test)}`);
    const doneCheck = lines.filter(Boolean).join('; ');
    // Untargeted items are `blocked` (the seed reconcile step would turn `open` into `ready` and the runner would refuse them).
    const status = t?.target ? 'ready' : 'blocked';
    const r = await db.prepare(`INSERT OR IGNORE INTO items (id, title, kind, project, owner_role, done_check, closing_probe, priority, status, disposition) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(it.id, it.title, it.kind || 'work', it.project || 'spec-to-code', it.owner_role || 'staff', doneCheck, it.closing_probe || 'manual', Number(it.priority) || 50, status, status === 'blocked' ? AWAITING : null).run();
    if (r.meta.changes) { out.seeded++; if (status === 'ready') out.ready++; else out.open++; continue; }
    out.existing++;
    // A target added later releases the item: the map is the only input a person or agent edits.
    if (t?.target) {
      const u = await db.prepare(`UPDATE items SET status='ready', done_check=?, disposition=NULL, updated_at=datetime('now') WHERE id=? AND status='blocked' AND disposition=?`).bind(doneCheck, it.id, AWAITING).run();
      out.promoted += u.meta.changes;
    }
  }
  return out;
}

export async function spendSince(db, sinceMs) {
  const r = await db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM router_calls WHERE at >= ?`).bind(iso(sinceMs)).first();
  return Number(r?.usd || 0);
}

/** { ok, reason, day_usd, month_usd }. A cap of null or 0 means "no paid spend allowed" only when explicitly 0; null means unset (refuse: a self-hosted run needs caps). */
export async function capGuard({ db, now, caps = {} }) {
  const t = now();
  const d = new Date(t);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const day_usd = await spendSince(db, dayStart), month_usd = await spendSince(db, monthStart);
  const num = v => (typeof v === 'number' && v >= 0 ? v : null);
  const dcap = num(caps.daily_usd), mcap = num(caps.monthly_usd);
  if (dcap === null || mcap === null) return { ok: false, reason: 'caps_not_configured', day_usd, month_usd };
  if (day_usd >= dcap) return { ok: false, reason: 'daily_cap_reached', day_usd, month_usd };
  if (month_usd >= mcap) return { ok: false, reason: 'monthly_cap_reached', day_usd, month_usd };
  return { ok: true, reason: 'under_caps', day_usd, month_usd };
}

/** Each wrapped step runs only while under the caps; otherwise it records why it was skipped. */
export function guardSteps(steps, { db, now, caps }) {
  return steps.map(s => ({
    name: s.name,
    run: async (d, ctx) => {
      const g = await capGuard({ db, now, caps });
      if (!g.ok) { ctx.notes.push(`${s.name} skipped: ${g.reason} (day $${g.day_usd.toFixed(4)}, month $${g.month_usd.toFixed(4)})`); return; }
      return s.run(d, ctx);
    },
  }));
}
