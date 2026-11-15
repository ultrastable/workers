// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The heartbeat. One call = one tick. Pure logic over a D1-compatible database handle,
// so the same code runs in the Worker (D1) and in tests (node:sqlite shim).
//
// Lesson from AIOS ("PID 1 must never die"): every step is guarded. A failing step is
// recorded in the tick's errors and as a backlog item; the remaining steps still run.

const TERMINAL = ['done', 'superseded', 'cancelled'];
const OPS = {
  '>=': (a, b) => a >= b, '<=': (a, b) => a <= b,
  '>': (a, b) => a > b, '<': (a, b) => a < b, '=': (a, b) => a === b,
};

async function all(db, sql, ...args) {
  const r = await db.prepare(sql).bind(...args).all();
  return r.results || [];
}
async function first(db, sql, ...args) {
  return (await db.prepare(sql).bind(...args).first()) || null;
}
async function run(db, sql, ...args) {
  return db.prepare(sql).bind(...args).run();
}
function iso(d) { return d.toISOString().replace('T', ' ').slice(0, 19); }

// Built-in metrics a prediction can name. Each returns a number.
export const METRICS = {
  tick_runs_completed_1h: (db, now) => first(db,
    `SELECT COUNT(*) AS n FROM tick_runs WHERE finished_at >= ? AND steps_completed = steps_total`,
    iso(new Date(now - 3600e3))).then(r => r.n),
  items_done: (db) => first(db, `SELECT COUNT(*) AS n FROM items WHERE status='done'`).then(r => r.n),
  open_gate_cards: (db) => first(db, `SELECT COUNT(*) AS n FROM gate_cards WHERE status='open'`).then(r => r.n),
  silent_drops_7d: (db, now) => first(db,
    `SELECT COUNT(*) AS n FROM outcomes WHERE result='silent_drop' AND at >= ?`,
    iso(new Date(now - 7 * 86400e3))).then(r => r.n),
};

export function reliability(successes, outcomes, trust) {
  const w = trust.prior_weight, b = trust.baseline;
  return (successes + b * w) / (outcomes + w);
}

async function ensureItem(db, item) {
  const existing = await first(db, `SELECT id FROM items WHERE id = ?`, item.id);
  if (existing) return false;
  await run(db, `INSERT INTO items (id, title, kind, owner_role, done_check, closing_probe, priority, status, surface, action_class)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
    item.id, item.title, item.kind || 'fix', item.owner_role, item.done_check,
    item.closing_probe || null, item.priority ?? 10, item.surface || null, item.action_class || null);
  return true;
}

// ---- execute (issue #173): the tick's own doer ----
// A dispatched item whose closing probe the tick can read by itself is settled in the tick that claimed it, so a claim is never
// left for an executor that does not exist. Anything else keeps its claim for an outside executor (core/runner, a code agent);
// if none heartbeats, reap_claims releases it with a disposition and parks it after max_unworked_releases.
const DOER = 'tick-doer';
const WAITING = 'waiting on probe:';

/** Read an item's closing probe. Returns { ok, detail }, or null when the probe is not one the tick can evaluate. */
export async function evalProbe(db, ctx, item) {
  const p = String(item.closing_probe || '').trim();
  let m;
  if ((m = /^TICKFAIL-([a-z0-9_]+)-/i.exec(item.id))) { // done check: "next tick completes step <name>"
    const t = await first(db, `SELECT id FROM tick_runs WHERE started_at > ? AND finished_at IS NOT NULL AND (errors IS NULL OR errors NOT LIKE ?) ORDER BY id LIMIT 1`,
      item.created_at || '', `%"${m[1]}:%`);
    return { ok: Boolean(t), detail: t ? `tick ${t.id} completed step ${m[1]} with no error` : `no tick since ${item.created_at} completed step ${m[1]}` };
  }
  if ((m = /^env:(\w+)$/.exec(p))) return { ok: Boolean(ctx.env && ctx.env[m[1]]), detail: `setting ${m[1]} is ${ctx.env && ctx.env[m[1]] ? 'present' : 'absent'}` };
  if ((m = /^item_done:(\S+)$/.exec(p))) {
    const d = await first(db, `SELECT 1 AS x FROM items WHERE id=? AND status='done'`, m[1]);
    return { ok: Boolean(d), detail: `item ${m[1]} is ${d ? 'done' : 'not done'}` };
  }
  if ((m = /^trust_ledger rung = (\S+)$/.exec(p)) && item.surface && item.action_class) {
    const r = await first(db, `SELECT rung FROM trust_ledger WHERE surface=? AND action_class=?`, item.surface, item.action_class);
    return { ok: Boolean(r && r.rung === m[1]), detail: `${item.surface}/${item.action_class} rung is ${r ? r.rung : 'unset'}` };
  }
  if (/^select\s[^;]+\sfrom\s[^;]+$/i.test(p)) { // one read-only statement; a first value above 0 passes
    try {
      const v = Number(Object.values((await first(db, p)) || {})[0]);
      return { ok: v > 0, detail: `probe returned ${Number.isFinite(v) ? v : 'no number'}` };
    } catch (e) { return { ok: false, detail: `probe could not run: ${String(e && e.message).slice(0, 80)}` }; }
  }
  return null;
}

async function settle(db, ctx, item, probe) {
  await run(db, `DELETE FROM claims WHERE item_id=?`, item.id);
  if (probe.ok) {
    await run(db, `UPDATE items SET status='done', blocker=NULL, disposition=?, updated_at=? WHERE id=?`,
      `done by ${DOER} in tick ${ctx.tickId}: ${probe.detail}`.slice(0, 300), ctx.nowIso, item.id);
    await run(db, `INSERT INTO outcomes (item_id, agent, surface, action_class, result, evidence, at) VALUES (?, ?, 'work_tracker', 'execute', 'verified', ?, ?)`,
      item.id, DOER, probe.detail.slice(0, 300), ctx.nowIso);
    await run(db, `UPDATE dispatches SET status='done' WHERE item_id=? AND status='queued'`, item.id);
    return 'done';
  }
  await run(db, `UPDATE items SET status='blocked', blocker=?, disposition=?, updated_at=? WHERE id=?`,
    `${WAITING} ${item.closing_probe || item.done_check} (${probe.detail})`.slice(0, 300),
    `parked by ${DOER} in tick ${ctx.tickId}: closes by its probe, rechecked every tick`, ctx.nowIso, item.id);
  return 'parked';
}

export const STEPS = {
  // Every item that left the active set has a disposition; items whose trigger is done become ready.
  async reconcile(db, ctx) {
    const drops = await all(db,
      `SELECT id FROM items WHERE status IN ('done','superseded','cancelled') AND (disposition IS NULL OR disposition = '')`);
    for (const d of drops) {
      await run(db, `UPDATE items SET status='open', updated_at=? WHERE id=?`, ctx.nowIso, d.id);
      await run(db, `INSERT INTO outcomes (item_id, surface, action_class, result, evidence) VALUES (?, 'work_tracker', 'create_update_close', 'silent_drop', 'reopened by reconcile: no disposition')`, d.id);
    }
    const r = await run(db, `UPDATE items SET status='ready', updated_at=?
      WHERE status='open' AND (trigger_on IS NULL OR trigger_on IN (SELECT id FROM items WHERE status='done'))`, ctx.nowIso);
    ctx.notes.push(`reconciled: ${drops.length} reopened, ${r.meta?.changes ?? 0} became ready`);
  },

  // Claims with no heartbeat for claim_ttl_minutes are released so work never stalls. A claim that was never heartbeated was
  // dispatched and not worked (issue #173): that is recorded as an outcome (surface dispatch / claim_release / unworked), and an
  // item released unworked `max_unworked_releases` times is parked with a reason instead of being claimed again for ever.
  async reap_claims(db, ctx) {
    const cutoff = iso(new Date(ctx.now - ctx.config.claim_ttl_minutes * 60e3));
    const maxRel = ctx.config.max_unworked_releases ?? 3;
    const stale = await all(db, `SELECT item_id, agent, claimed_at, heartbeat_at FROM claims WHERE heartbeat_at < ?`, cutoff);
    let unworked = 0, parked = 0;
    for (const c of stale) {
      await run(db, `DELETE FROM claims WHERE item_id=?`, c.item_id);
      if (c.heartbeat_at !== c.claimed_at) { // someone worked it, then went quiet: plain release
        await run(db, `UPDATE items SET status='ready', updated_at=? WHERE id=? AND status='claimed'`, ctx.nowIso, c.item_id);
        continue;
      }
      unworked++;
      await run(db, `INSERT INTO outcomes (item_id, agent, surface, action_class, result, evidence, at) VALUES (?, ?, 'dispatch', 'claim_release', 'unworked', ?, ?)`,
        c.item_id, c.agent, `claim by ${c.agent} released after ${ctx.config.claim_ttl_minutes} min with no heartbeat`, ctx.nowIso);
      const n = (await first(db, `SELECT COUNT(*) AS n FROM outcomes WHERE item_id=? AND surface='dispatch' AND action_class='claim_release' AND result='unworked'`, c.item_id)).n;
      if (n >= maxRel) {
        parked++;
        await run(db, `UPDATE items SET status='blocked', blocker=?, disposition=?, updated_at=? WHERE id=? AND status='claimed'`,
          `no executor worked this item: dispatched and released unworked ${n} times`,
          `parked: dispatched ${n} times, never worked; needs an executor that reads this store (issue #173)`, ctx.nowIso, c.item_id);
      } else {
        await run(db, `UPDATE items SET status='ready', disposition=?, updated_at=? WHERE id=? AND status='claimed'`,
          `released unworked (${n}/${maxRel}) ${ctx.nowIso}`, ctx.nowIso, c.item_id);
      }
    }
    if (stale.length) ctx.notes.push(`released ${stale.length} stale claim(s), ${unworked} unworked, ${parked} parked`);
  },

  // Gate cards close themselves when their probe shows the owner's step is done.
  async probe_gates(db, ctx) {
    const cards = await all(db, `SELECT id, closing_probe FROM gate_cards WHERE status='open'`);
    let closed = 0;
    for (const c of cards) {
      const [kind, arg] = c.closing_probe.split(':');
      let ok = false;
      if (kind === 'env') ok = Boolean(ctx.env && ctx.env[arg]);
      if (kind === 'item_done') ok = Boolean(await first(db, `SELECT 1 AS x FROM items WHERE id=? AND status='done'`, arg));
      if (ok) {
        await run(db, `UPDATE gate_cards SET status='closed', closed_at=? WHERE id=?`, ctx.nowIso, c.id);
        closed++;
      }
    }
    ctx.openGates = cards.length - closed;
    if (closed) ctx.notes.push(`closed ${closed} gate card(s) by probe`);
  },

  // Predictions due now are graded against built-in metrics.
  async score_predictions(db, ctx) {
    const due = await all(db, `SELECT * FROM predictions WHERE verdict IS NULL AND due_at <= ?`, ctx.nowIso);
    for (const p of due) {
      const own = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);
      const metric = own(METRICS, p.metric) ? METRICS[p.metric] : own(ctx.metrics, p.metric) ? ctx.metrics[p.metric] : null; // built-ins cannot be shadowed; domain metrics come from runTick option `metrics`
      const op = own(OPS, p.op) ? OPS[p.op] : null;
      if (!metric || !op) {
        await run(db, `UPDATE predictions SET verdict='miss', observed=NULL WHERE id=?`, p.id);
        ctx.notes.push(`prediction ${p.id}: unknown metric or op, scored miss`);
        continue;
      }
      let observed;
      try {
        let timer;
        observed = await Promise.race([Promise.resolve(metric(db, ctx.now, p)), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('metric timed out')), 10000); })]).finally(() => clearTimeout(timer));
      } catch (e) { observed = NaN; ctx.notes.push(`prediction ${p.id}: metric ${p.metric} failed: ${String(e && e.message).slice(0, 120)}`); }
      if (typeof observed !== 'number' || !Number.isFinite(observed)) {
        await run(db, `UPDATE predictions SET verdict='miss', observed=NULL WHERE id=?`, p.id);
        ctx.notes.push(`prediction ${p.id}: metric returned no finite number, scored miss`);
        continue;
      }
      const verdict = op(observed, p.target) ? 'hit' : 'miss';
      await run(db, `UPDATE predictions SET observed=?, verdict=? WHERE id=?`, observed, verdict, p.id);
      ctx.notes.push(`prediction ${p.id}: ${p.metric}=${observed} ${verdict}`);
    }
  },

  // Trust per (surface, action_class) from recorded outcomes; a crossed threshold opens a ladder PR item.
  async accrue_trust(db, ctx) {
    const { trust, ladder } = ctx.config.policy;
    const rows = await all(db, `SELECT surface, action_class,
        SUM(CASE WHEN result='verified' THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN result IN ('hidden_failure','silent_drop') THEN 1 ELSE 0 END) AS severe,
        COUNT(*) AS n
      FROM outcomes GROUP BY surface, action_class`);
    for (const r of rows) {
      const rel = reliability(r.ok, r.n, trust);
      const cur = await first(db, `SELECT rung FROM trust_ledger WHERE surface=? AND action_class=?`, r.surface, r.action_class);
      const rung = cur ? cur.rung : ctx.config.policy.surfaces[r.surface]?.start_rung || 'observed';
      await run(db, `INSERT INTO trust_ledger (surface, action_class, rung, reliability, outcomes, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(surface, action_class) DO UPDATE SET reliability=excluded.reliability, outcomes=excluded.outcomes, updated_at=excluded.updated_at`,
        r.surface, r.action_class, rung, rel, r.n, ctx.nowIso);
      const idx = ladder.rungs.indexOf(rung);
      const maxPerm = ctx.config.policy.surfaces[r.surface]?.max_permission || 'none';
      const ceilingIdx = ladder.rungs.indexOf(ladder.ceiling_by_max_permission[maxPerm] || 'observed');
      const promote = idx >= 0 && idx < ceilingIdx && r.n >= ladder.promote_when.min_outcomes
        && rel >= ladder.promote_when.min_reliability && r.severe === 0;
      const demote = idx > 0 && (rel < ladder.demote_when.reliability_below || r.severe > 0);
      if (promote || demote) {
        const to = ladder.rungs[promote ? idx + 1 : idx - 1];
        const made = await ensureItem(db, {
          id: `LADDER-${r.surface}-${r.action_class}-${to}`,
          title: `${promote ? 'Promote' : 'Demote'} ${r.surface}/${r.action_class} from ${rung} to ${to} (reliability ${rel.toFixed(2)} over ${r.n})`,
          kind: 'ladder', owner_role: 'operations',
          done_check: 'PR to autonomy/policy.json merged after review by a different agent',
          closing_probe: `trust_ledger rung = ${to}`, priority: demote ? 0 : 20,
          surface: r.surface, action_class: r.action_class,
        });
        if (made) ctx.notes.push(`ladder item opened: ${r.surface}/${r.action_class} -> ${to}`);
      }
    }
  },

  // Roles whose tick is due pull the top ready item for their role and get a dispatch row.
  async dispatch(db, ctx) {
    const roles = await all(db, `SELECT * FROM roles`);
    let n = 0;
    for (const role of roles) {
      if (ctx.tickId % Math.max(1, role.tick_every) !== 0) continue;
      const wip = await first(db, `SELECT COUNT(*) AS n FROM claims WHERE agent=?`, role.id);
      if (wip.n >= ctx.config.max_wip_per_role) continue;
      // An item may name its role ('product-manager') or one role instance ('product-manager-3', as metric breaches do); both reach it.
      // Matching only the role name left every instance-addressed item ready and undispatched for ever (found live 2026-11-13).
      // When a code executor is running (ctx.config.executor_takes_targeted), an item that names its target file is the
      // executor's: a role claim on it would hide it from the executor and then be released unworked (CRIT-3).
      const item = await first(db, `SELECT id FROM items WHERE status='ready' AND (owner_role=? OR owner_role=?)
          AND (project IS NULL OR project = ? OR ? IS NULL)${ctx.config.executor_takes_targeted ? ` AND done_check NOT LIKE '%target:%'` : ''}
          AND id NOT IN (SELECT item_id FROM claims) ORDER BY (owner_role=?) DESC, priority, created_at LIMIT 1`,
        role.role, role.id, role.project, role.project, role.id);
      await run(db, `UPDATE roles SET last_tick_at=? WHERE id=?`, ctx.nowIso, role.id);
      if (!item) continue;
      await run(db, `INSERT INTO claims (item_id, agent, claimed_at, heartbeat_at) VALUES (?, ?, ?, ?)`, item.id, role.id, ctx.nowIso, ctx.nowIso);
      await run(db, `UPDATE items SET status='claimed', updated_at=? WHERE id=?`, ctx.nowIso, item.id);
      await run(db, `INSERT INTO dispatches (tick_id, role_id, item_id, model) VALUES (?, ?, ?, ?)`, ctx.tickId, role.id, item.id, role.model);
      n++;
    }
    ctx.dispatched = n;
    ctx.notes.push(`dispatched ${n} item(s)`);
  },

  // Issue #173: every item claimed by dispatch whose probe the tick can read ends done (with evidence) or parked on that probe;
  // parked items are re-read every tick (a bounded, rotating window) and close themselves when the probe passes.
  async execute(db, ctx) {
    const max = ctx.config.execute_max_items ?? 20;
    const count = { done: 0, parked: 0, left: 0, reopened: 0 };
    const parkedN = (await first(db, `SELECT COUNT(*) AS n FROM items WHERE status='blocked' AND blocker LIKE ?`, `${WAITING}%`)).n;
    const waiting = await all(db, `SELECT * FROM items WHERE status='blocked' AND blocker LIKE ? ORDER BY id LIMIT ? OFFSET ?`,
      `${WAITING}%`, max, parkedN > max ? (ctx.tickId * max) % parkedN : 0);
    for (const it of waiting) {
      const probe = await evalProbe(db, ctx, it);
      if (probe && probe.ok) { await settle(db, ctx, it, probe); count.done++; count.reopened++; }
    }
    const claimed = await all(db, `SELECT i.* FROM items i JOIN claims c ON c.item_id = i.id JOIN roles r ON r.id = c.agent
      WHERE i.status='claimed' AND c.heartbeat_at = c.claimed_at ORDER BY i.priority, c.claimed_at LIMIT ?`, max);
    for (const it of claimed) {
      const probe = await evalProbe(db, ctx, it);
      if (!probe) { count.left++; continue; }
      count[await settle(db, ctx, it, probe)]++;
    }
    ctx.executed = count;
    ctx.notes.push(`executed: ${count.done} done (${count.reopened} from parked), ${count.parked} parked on a probe, ${count.left} left for an executor`);
  },

  // Plus share over the last 20 closed items; below target opens a rebalance item for the portfolio manager.
  async check_plus_share(db, ctx) {
    const rows = await all(db, `SELECT kind FROM items WHERE status='done' ORDER BY updated_at DESC LIMIT 20`);
    if (rows.length < 10) return;
    const share = rows.filter(r => r.kind === 'plus').length / rows.length;
    ctx.plusShare = share;
    if (share < ctx.config.plus_share / 2) {
      const made = await ensureItem(db, {
        id: `REBALANCE-${ctx.nowIso.slice(0, 10)}`,
        title: `Plus share ${(share * 100).toFixed(0)}% is under half the ${ctx.config.plus_share * 100}% target; rebalance and file the cause`,
        kind: 'fix', owner_role: 'portfolio-manager',
        done_check: 'plus share back over half the target over the next 20 closed items', priority: 5,
      });
      if (made) ctx.notes.push('rebalance item opened');
    }
  },
};

export const STEP_ORDER = ['reconcile', 'reap_claims', 'probe_gates', 'score_predictions', 'accrue_trust', 'dispatch', 'execute', 'check_plus_share'];

// extraSteps: optional [{ name, run(db, ctx) }] appended after the eight L1 steps (extension point for higher layers).
// metrics: optional { name: async (db, nowMs, predictionRow) => number }, consulted before the built-ins when a due prediction is scored.
export async function runTick(db, { config, env = {}, now = Date.now(), extraSteps = [], metrics = {} } = {}) {
  const steps = [...STEP_ORDER.map(name => ({ name, run: STEPS[name] })), ...extraSteps];
  const startedIso = iso(new Date(now));
  const ins = await run(db, `INSERT INTO tick_runs (started_at, steps_total) VALUES (?, ?)`, startedIso, steps.length);
  const tickId = ins.meta.last_row_id;
  const ctx = { config, env, now, nowIso: startedIso, tickId, notes: [], errors: [], dispatched: 0, openGates: 0, metrics };
  let completed = 0;
  for (const { name, run: stepRun } of steps) {
    try {
      await stepRun(db, ctx);
      completed++;
    } catch (e) {
      ctx.errors.push(`${name}: ${e.message}`);
      try {
        await ensureItem(db, {
          id: `TICKFAIL-${name}-${startedIso.slice(0, 13).replace(' ', 'T')}`,
          title: `Tick step ${name} failed: ${e.message}`.slice(0, 300),
          owner_role: 'operations', done_check: `next tick completes step ${name}`, priority: 0,
        });
      } catch { /* the database itself is down; the error is still in tick_runs */ }
    }
  }
  const open = await first(db, `SELECT COUNT(*) AS n FROM items WHERE status NOT IN ('done','superseded','cancelled')`);
  const report = [
    `Happened: tick ${tickId} ran ${completed}/${steps.length} steps; ${ctx.notes.join('; ') || 'no changes'}.`,
    `Decided: dispatched ${ctx.dispatched} item(s) in driver order.`,
    `Next: tick ${tickId + 1} on the next cron.`,
    `Open: ${open.n} active item(s), ${ctx.openGates} gate card(s)${ctx.errors.length ? `, errors: ${ctx.errors.join(' | ')}` : ''}.`,
  ].join('\n');
  await run(db, `UPDATE tick_runs SET finished_at=?, steps_completed=?, report=?, errors=? WHERE id=?`,
    iso(new Date(now)), completed, report, ctx.errors.length ? JSON.stringify(ctx.errors) : null, tickId);
  return { tickId, completed, total: steps.length, report, errors: ctx.errors };
}

export { TERMINAL };
