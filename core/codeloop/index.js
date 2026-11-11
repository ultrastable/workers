// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Code loop (item -> tested, reviewed, merged change). Extends core/runner, which stops at a DRAFT pull request:
// this module adds the task line parser and the merge gate. Ports: ctx = { db, now(), config, hosts, rung?(surface, class) }.
// hosts is an ORDERED LIST of merge routes ({ name, merge({pr, method}) }): no single route (a failing host falls to the next).
// Merge is allowed only when: run approved with passing checks, no protected path, rung >= config.merge_min_rung, kill switch off.

const RUNGS = ['observed', 'assisted', 'delegated', 'autonomous', 'self-directed', 'self-modifying', 'self-extending'];
const DEFAULTS = { merge_min_rung: 'autonomous', merge_method: 'squash', protected_paths: [], max_files: 20, done_owner_role: 'project-manager' };
export const cfg = ctx => ({ ...DEFAULTS, ...(ctx.config || {}) });
const nowMs = ctx => { const v = ctx.now(); return v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v.includes('T') ? v : v.replace(' ', 'T') + 'Z') : v; };
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();

/** Parse the "code-task:" line of an item body: key=value pairs separated by ";". Returns null when absent. */
export function parseTask(body) {
  const m = /^\s*code-task:\s*(.+)$/im.exec(String(body || ''));
  if (!m) return null;
  const t = { paths: [], test: null, base: null };
  for (const part of m[1].split(';')) {
    const [k, ...v] = part.split('=');
    const key = (k || '').trim().toLowerCase(), val = v.join('=').trim();
    if (key === 'paths') t.paths = val.split(',').map(s => s.trim()).filter(Boolean);
    else if (key === 'test') t.test = val || null;
    else if (key === 'base') t.base = val || null;
  }
  return t.paths.length ? t : null;
}

const isProtected = (p, list) => list.some(x => p === x || p.startsWith(x.endsWith('/') ? x : x + '/'));

/** Pure decision: returns { ok, reason }. */
export function mergeDecision({ run: r, files = [], rung = 'observed', killed = false }, c) {
  if (killed) return { ok: false, reason: 'kill_switch' };
  if (!r || r.state !== 'approved') return { ok: false, reason: 'not_approved' };
  if (!r.pr_number) return { ok: false, reason: 'no_pull_request' };
  if (files.length > c.max_files) return { ok: false, reason: 'too_many_files' };
  const bad = files.filter(f => isProtected(f, c.protected_paths));
  if (bad.length) return { ok: false, reason: 'protected_path:' + bad.join(',') };
  if (RUNGS.indexOf(rung) < RUNGS.indexOf(c.merge_min_rung)) return { ok: false, reason: 'rung_below_' + c.merge_min_rung };
  return { ok: true, reason: 'gate_passed' };
}

/** Merge one approved run through the first host that accepts it. Returns { merged, host?, reason }. */
export async function mergeRun(ctx, runId, { files = [], killed = false } = {}) {
  const c = cfg(ctx), ts = iso(nowMs(ctx));
  const r = await first(ctx.db, 'SELECT * FROM runner_runs WHERE id = ?', runId);
  const rung = ctx.rung ? await ctx.rung('code', 'merge') : 'observed';
  const d = mergeDecision({ run: r, files, rung, killed }, c);
  const log = (decision, host, reason, attempts) => run(ctx.db,
    'INSERT INTO codeloop_merges (run_id, item_id, pr_number, decision, host, reason, attempts_json, at) VALUES (?,?,?,?,?,?,?,?)',
    runId, r?.item_id ?? null, r?.pr_number ?? null, decision, host ?? null, reason, JSON.stringify(attempts || []), ts);
  if (!d.ok) { await log('refused', null, d.reason); return { merged: false, reason: d.reason }; }
  const hosts = ctx.hosts || [];
  if (!hosts.length) { await log('failed', null, 'no_host_configured'); return { merged: false, reason: 'no_host_configured' }; }
  const attempts = [];
  for (const h of hosts) {
    try {
      const res = await h.merge({ pr: r.pr_number, method: c.merge_method });
      if (res && res.merged) {
        attempts.push({ host: h.name, ok: true });
        await log('merged', h.name, 'merged', attempts);
        await run(ctx.db, "UPDATE items SET status='done', disposition='merged via ' || ?, updated_at=datetime('now') WHERE id=? AND status IN ('open','ready','claimed')", h.name, r.item_id);
        return { merged: true, host: h.name, reason: 'merged' };
      }
      attempts.push({ host: h.name, ok: false, error: String(res?.reason || 'not_merged').slice(0, 200) });
    } catch (e) { attempts.push({ host: h.name, ok: false, error: String(e?.message || e).slice(0, 200) }); }
  }
  await log('failed', null, 'all_hosts_failed', attempts);
  return { merged: false, reason: 'all_hosts_failed', attempts };
}

/** Tick step: merge every approved run with a pull request, bounded per tick. */
export async function sweep(ctx, { limit = 3, filesOf, killed = false } = {}) {
  const rows = (await ctx.db.prepare("SELECT id FROM runner_runs WHERE state='approved' AND pr_number IS NOT NULL AND id NOT IN (SELECT run_id FROM codeloop_merges WHERE decision='merged') ORDER BY id LIMIT ?").bind(limit).all()).results || [];
  const out = [];
  for (const r of rows) out.push({ run: r.id, ...(await mergeRun(ctx, r.id, { files: filesOf ? await filesOf(r.id) : [], killed })) });
  return out;
}
