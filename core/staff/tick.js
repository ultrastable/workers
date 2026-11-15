// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The managers' part of the L2 tick (US-SPEC-03 s4 steps 312 to 316): each due persona applies the operations on its own
// list through the tool layer, originates, scores its focus set, and writes one brief (US-02-R05, R07).
import { all, first, iso, parseIso, TERMINAL_SQL } from '../kernel/util.js';
import { createToolLayer, writeBrief, normTitle, isMachineFiled, logAction } from './index.js';
import { scoreItem } from './score.js';
import { originate } from './originate.js';

const IN_PROGRAM = `(i.project = ? OR i.project IN (SELECT id FROM kernel_projects WHERE program_id = ?))`;
const ACTIVE = `i.status NOT IN ${TERMINAL_SQL}`;

async function programDuties(tools, pz, tickId, notes) {
  const { db, config: c } = tools, can = (op) => pz.authority.includes(op), P = pz.program_id;
  const items = await all(db, `SELECT i.id, i.title, i.priority, i.created_at, m.metric_id FROM items i LEFT JOIN kernel_item_meta m ON m.item_id = i.id
      WHERE ${ACTIVE} AND ${IN_PROGRAM} ORDER BY i.created_at, i.id`, P, P);
  const gone = new Set();
  if (can('close_with_evidence')) {
    for (const it of items.filter(i => i.metric_id)) {
      const r = await tools.act(pz.id, 'close_with_evidence', { item_id: it.id }, { tickId, quiet: true });
      if (r.ok) gone.add(it.id);
    }
  }
  if (can('supersede')) { // within a group of equal titles, every item but the newest is superseded by the newest
    const groups = new Map();
    for (const it of items.filter(i => !gone.has(i.id))) { const k = normTitle(it.title); if (k) groups.set(k, [...(groups.get(k) || []), it]); }
    for (const g of groups.values()) {
      const keep = g[g.length - 1];
      for (const it of g.slice(0, -1)) if ((await tools.act(pz.id, 'supersede', { item_id: it.id, by: keep.id }, { tickId, quiet: true })).ok) gone.add(it.id);
    }
  }
  const focus = await all(db, `SELECT f.item_id, f.tier, i.priority FROM kernel_focus f JOIN items i ON i.id = f.item_id WHERE f.program_id = ? ORDER BY f.rank`, P);
  if (can('promote')) { // a focus item that serves the primary or a guard metric is raised from medium to high
    for (const f of focus.filter(f => f.tier <= 1 && f.priority > c.high_priority_max && !gone.has(f.item_id))) await tools.act(pz.id, 'promote', { item_id: f.item_id }, { tickId, quiet: true });
  }
  if (can('score')) for (const f of focus.filter(f => !gone.has(f.item_id))) await scoreItem(tools, pz.id, f.item_id, {}, { tickId });
  if (can('originate')) {
    const o = await originate(tools, pz.id, { tickId });
    if (o.filed) notes.push(`originated ${o.filed}`); else if (o.skipped) notes.push(`no origination: ${o.skipped}`);
  }
}

async function portfolioDuties(tools, pz, tickId, notes) {
  const { db, config: c } = tools, now = tools.now();
  if (pz.authority.includes('demote')) {
    const cutoff = iso(now - c.demote_after_h * 3600e3);
    const stale = await all(db, `SELECT i.id, m.metric_id FROM items i LEFT JOIN kernel_item_meta m ON m.item_id = i.id
        WHERE ${ACTIVE} AND (i.priority <= 0 OR m.critical = 1) AND i.created_at < ? AND m.doer IS NULL
          AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.item_id = i.id) ORDER BY i.created_at, i.id`, cutoff);
    for (const it of stale.filter(i => isMachineFiled(i, c))) await tools.act(pz.id, 'demote', { item_id: it.id }, { tickId, quiet: true });
  }
  // The kernel's allocation of this tick is logged as this persona's operation when allocate is on its list (US-02-R06).
  if (pz.authority.includes('allocate') && tickId !== null) {
    const cur = await all(db, `SELECT program_id, slots FROM kernel_allocations WHERE tick_id = ? ORDER BY program_id`, tickId);
    if (cur.length && !(await first(db, `SELECT 1 AS x FROM staff_actions WHERE op = 'allocate' AND tick_id = ?`, tickId))) {
      const prevTick = (await first(db, `SELECT MAX(tick_id) AS t FROM kernel_allocations WHERE tick_id < ?`, tickId))?.t;
      const prev = prevTick ? await all(db, `SELECT program_id, slots FROM kernel_allocations WHERE tick_id = ? ORDER BY program_id`, prevTick) : [];
      const fmt = (rows) => rows.map(r => `${r.program_id}=${r.slots}`).join(' ') || null;
      await logAction(db, pz, { op: 'allocate', field: 'allocation', from: fmt(prev), to: fmt(cur), evidence: `decision ALLOC-${tickId}`, tick_id: tickId, at: iso(now) });
    }
  } else if (tickId !== null && !pz.authority.includes('allocate')) notes.push('allocation is not on my list; the kernel rule allocated');
}

// Run every due persona. ctx: { tickId, now (ms), config: { staff }, ports: { readFile, research } }.
// A persona filled by a person is never acted for; it gets its brief when it wrote rows on this tick (US-02-R11).
export async function runManagers(db, ctx = {}) {
  const now = ctx.now ?? Date.now(), tickId = ctx.tickId ?? null;
  const base = createToolLayer({ db, now: () => now, config: ctx.config?.staff, ports: ctx.ports || {} });
  const tools = base;
  const out = { personas: 0, briefs: 0, errors: [] };
  for (const row of await all(db, `SELECT id FROM staff_personas WHERE status = 'active' ORDER BY (role = 'portfolio-manager') DESC, id`)) {
    const pz = await base.identity(row.id), notes = [];
    const wrote = tickId !== null && (await first(db, `SELECT (SELECT COUNT(*) FROM staff_actions WHERE persona_id = ? AND tick_id = ?) + (SELECT COUNT(*) FROM staff_denials WHERE persona_id = ? AND tick_id = ?) AS n`, pz.id, tickId, pz.id, tickId)).n > 0;
    const due = tickId === null || tickId % Math.max(1, pz.tick_every) === 0;
    if (pz.filled_by === 'person') { if (wrote) { await writeBrief(db, pz.id, tickId, now); out.briefs++; } continue; }
    if (!due && !wrote) continue;
    out.personas++;
    if (due) {
      try { if (pz.program_id) await programDuties(tools, pz, tickId, notes); else await portfolioDuties(tools, pz, tickId, notes); }
      catch (e) { out.errors.push(`${pz.id}: ${e.message}`); notes.push(`stopped on an error: ${e.message}`); }
    }
    if (tickId !== null) { await writeBrief(db, pz.id, tickId, now, notes); out.briefs++; }
  }
  return out;
}

// Tick step for the composition root: runTick(db, { extraSteps: [...L2_EXTRA_STEPS, staffStep({ readFile, research })] }).
// It runs after the kernel's 'l2' step, which writes the allocation and focus rows the managers read.
export function staffStep(ports = {}) {
  return { name: 'staff', run: async (db, ctx) => {
    if (ctx.config?.staff?.enabled === false || ctx.config?.kernel?.manager_ops === false) { ctx.notes?.push('staff: manager operations off'); return; }
    const r = await runManagers(db, { tickId: ctx.tickId, now: typeof ctx.now === 'number' ? ctx.now : parseIso(ctx.nowIso), config: ctx.config, ports });
    ctx.notes?.push(`staff: ${r.personas} persona(s), ${r.briefs} brief(s)`);
    if (r.errors.length) throw new Error(r.errors.join(' | '));
  } };
}
