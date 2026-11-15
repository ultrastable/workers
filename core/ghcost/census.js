// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// core/ghcost: stagger with a measured collision count (US-24-R50), the census of workflows and runner users that must
// exist before anything is retired, and the frozen or dead monitor check (US-24-R52).
import { iso, nowMs, all, first, run, cfg, fileItem, closeItem, recordProbe } from './util.js';

/** FNV-1a, 32 bit: a stable hash with no platform dependency. */
export function hash32(text) {
  let h = 0x811c9dc5;
  for (const ch of new TextEncoder().encode(String(text))) { h ^= ch; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
/** Deterministic offset in minutes for a recurring job: the same name and period always give the same minute. */
export const staggerOffset = (name, everyMinutes) => hash32(name) % Math.max(1, Math.floor(everyMinutes));

/** Collisions over a horizon: for each minute where k jobs fire together, k - 1 collisions. Also the worst minute. */
export function collisionCount(jobs, horizonMinutes = 1440) {
  const load = new Map();
  for (const j of jobs) {
    const every = Math.max(1, Math.floor(j.every)), off = ((j.offset ?? 0) % every + every) % every;
    for (let t = off; t < horizonMinutes; t += every) load.set(t, (load.get(t) || 0) + 1);
  }
  let collisions = 0, worst = 0;
  for (const n of load.values()) { if (n > 1) collisions += n - 1; if (n > worst) worst = n; }
  return { collisions, worst };
}

/**
 * Assign every job an offset: start at its hash offset and take the least loaded minute of its period, scanning forward.
 * Jobs are placed in name order, so the plan is the same on every run. Returns the plan with the count before and after.
 */
export function stagger(jobs, horizonMinutes = 1440) {
  const before = collisionCount(jobs.map(j => ({ ...j, offset: j.offset ?? 0 })), horizonMinutes);
  const load = new Map(), plan = [];
  for (const j of [...jobs].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const every = Math.max(1, Math.floor(j.every)), start = staggerOffset(j.name, every);
    let best = start, bestCost = Infinity;
    for (let k = 0; k < every && bestCost > 0; k++) {
      const off = (start + k) % every; let cost = 0;
      for (let t = off; t < horizonMinutes; t += every) cost += load.get(t) || 0;
      if (cost < bestCost) { bestCost = cost; best = off; }
    }
    for (let t = best; t < horizonMinutes; t += every) load.set(t, (load.get(t) || 0) + 1);
    plan.push({ name: j.name, every, offset: best });
  }
  const after = collisionCount(plan, horizonMinutes);
  return { jobs: plan, collisions_before: before.collisions, worst_before: before.worst, collisions: after.collisions, worst: after.worst };
}

/**
 * Pure census. workflows: [{ repo, file, state }] as the platform lists them; runs: [{ repo, workflow, at, runner }];
 * roster: ['file.yml', ...] the names the organization believes it runs. A workflow that ran inside the window is active
 * whether or not the roster names it: absence from a roster is not proof of idleness.
 */
export function census({ workflows = [], runs = [], roster = [], now, idleDays = 30 }) {
  const cutoff = now - idleDays * 86400000, names = new Set(roster.map(r => String(r).split(':')[0]));
  const key = (repo, wf) => repo + '\u0000' + wf, seen = new Map();
  for (const w of workflows) seen.set(key(w.repo, w.file), { repo: w.repo, workflow: w.file, state: w.state || null, runs: 0, last_run_at: null, runners: new Set(), listed: true });
  for (const r of runs) {
    const k = key(r.repo, r.workflow);
    if (!seen.has(k)) seen.set(k, { repo: r.repo, workflow: r.workflow, state: null, runs: 0, last_run_at: null, runners: new Set(), listed: false });
    const row = seen.get(k), at = Date.parse(r.at);
    if (!(at >= cutoff)) continue;
    row.runs++; row.runners.add(r.runner || 'hosted');
    if (!row.last_run_at || at > Date.parse(row.last_run_at)) row.last_run_at = new Date(at).toISOString();
  }
  const rows = [...seen.values()].map(r => ({ ...r, runners: [...r.runners].sort(), in_roster: names.has(r.workflow), status: r.runs > 0 ? 'active' : 'idle' }))
    .sort((a, b) => (a.repo + a.workflow).localeCompare(b.repo + b.workflow));
  const measured = new Set(rows.map(r => r.workflow));
  return {
    rows,
    unrostered_active: rows.filter(r => r.status === 'active' && !r.in_roster).map(r => `${r.repo}/${r.workflow}`),
    roster_unmeasured: [...names].filter(n => !measured.has(n)).sort(),
    retirable: rows.filter(r => r.status === 'idle').map(r => `${r.repo}/${r.workflow}`),
  };
}

/** Measure every configured repository through the port, store the census and file what it finds. */
export async function censusRun(ctx) {
  const c = cfg(ctx), now = nowMs(ctx), ts = iso(now), db = ctx.db;
  const repos = c.repos || Object.keys(c.budget?.per_repo || {});
  const roster = c.roster || [...(c.budget?.essential_workflows || []), ...(c.budget?.non_essential_workflows || [])];
  const workflows = [], runs = [], unreadable = [];
  for (const repo of repos) {
    try {
      for (const w of await ctx.github.listWorkflows(repo)) workflows.push({ repo, ...w });
      for (const r of await ctx.github.listRuns(repo)) runs.push({ repo, ...r });
    } catch (e) { unreadable.push(repo); }
  }
  const result = census({ workflows, runs, roster, now, idleDays: c.idle_days || 30 });
  for (const r of result.rows) {
    await run(db, `INSERT INTO ghcost_census (repo, workflow, state, runs, last_run_at, runners, in_roster, status, measured_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(repo, workflow) DO UPDATE SET state=excluded.state, runs=excluded.runs, last_run_at=excluded.last_run_at, runners=excluded.runners, in_roster=excluded.in_roster, status=excluded.status, measured_at=excluded.measured_at`,
      r.repo, r.workflow, r.state, r.runs, r.last_run_at, JSON.stringify(r.runners), r.in_roster ? 1 : 0, r.status, ts);
  }
  if (result.unrostered_active.length) {
    await fileItem(db, { id: 'GHCOST-CENSUS-UNROSTERED', title: `Workflows run and are missing from the roster: ${result.unrostered_active.join(', ')}`,
      done_check: 'every active workflow is named in the roster or retired after a census', closing_probe: 'ghcost census: unrostered_active is empty', priority: 20 }, ts);
  } else if (!unreadable.length) await closeItem(db, 'GHCOST-CENSUS-UNROSTERED', 'every active workflow is in the roster', ts);
  await recordProbe(db, 'census', unreadable.length ? 'unknown' : 'pass', { workflows: result.rows.length, unrostered_active: result.unrostered_active, unreadable }, ts);
  return { ...result, unreadable };
}

/** Retiring is allowed only for a workflow a recent census measured idle (US-24-R52: measure before anything is retired). */
export async function canRetire(ctx, { repo, workflow }) {
  const maxAge = (cfg(ctx).census_max_age_days || 7) * 86400000;
  const row = await first(ctx.db, `SELECT status, measured_at FROM ghcost_census WHERE repo=? AND workflow=?`, repo, workflow);
  if (!row) return { ok: false, reason: 'not_measured' };
  if (nowMs(ctx) - Date.parse(row.measured_at.replace(' ', 'T') + 'Z') > maxAge) return { ok: false, reason: 'census_stale' };
  return row.status === 'idle' ? { ok: true, reason: 'measured_idle' } : { ok: false, reason: 'measured_active' };
}

/**
 * Pure monitor check. rows: [{ target, checked_at, status }] (the latest row per probe target). Frozen: a share of the
 * targets at or above `frozenShare` carry one identical timestamp older than `staleHours`. Dead: status 404 or 410.
 */
export function monitorHealth(rows, { now, staleHours = 6, frozenShare = 0.5 } = {}) {
  const by = new Map();
  for (const r of rows) by.set(r.checked_at, (by.get(r.checked_at) || 0) + 1);
  let frozenAt = null, frozenCount = 0;
  for (const [at, n] of by) {
    if (n > frozenCount && now - Date.parse(at) > staleHours * 3600000) { frozenAt = at; frozenCount = n; }
  }
  const frozen = rows.length > 0 && frozenCount / rows.length >= frozenShare;
  const dead = rows.filter(r => [404, 410].includes(Number(r.status))).map(r => r.target).sort();
  return { targets: rows.length, frozen, frozen_at: frozen ? frozenAt : null, frozen_count: frozen ? frozenCount : 0, dead };
}

/** File an item for a frozen monitor and one for dead targets; close them when the monitor is healthy again. */
export async function monitorRun(ctx, rows, opts = {}) {
  const now = nowMs(ctx), ts = iso(now), h = monitorHealth(rows, { now, ...opts });
  if (h.frozen) await fileItem(ctx.db, { id: 'GHCOST-MONITOR-FROZEN', title: `Monitor frozen: ${h.frozen_count} of ${h.targets} probe targets share the timestamp ${h.frozen_at}`,
    done_check: 'probe targets carry fresh, distinct timestamps', closing_probe: 'ghcost monitor: frozen is false', priority: 5 }, ts);
  else await closeItem(ctx.db, 'GHCOST-MONITOR-FROZEN', 'probe timestamps are fresh', ts);
  if (h.dead.length) await fileItem(ctx.db, { id: 'GHCOST-MONITOR-DEAD', title: `Monitor probes dead targets: ${h.dead.slice(0, 20).join(', ')}`,
    done_check: 'no probe target answers 404 or 410', closing_probe: 'ghcost monitor: dead is empty', priority: 20 }, ts);
  else await closeItem(ctx.db, 'GHCOST-MONITOR-DEAD', 'no dead probe target', ts);
  await recordProbe(ctx.db, 'monitor', h.frozen || h.dead.length ? 'fail' : 'pass', h, ts);
  return h;
}
export const censusRows = db => all(db, `SELECT * FROM ghcost_census ORDER BY repo, workflow`);
