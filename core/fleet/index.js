// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Fleet runtime (US-SPEC-11): worker contract and registry reconciliation, row-driven dispatcher, typed executor with an
// eleven-column run ledger and validated event envelopes, the batch accounting invariant as a gate, the slot-counting
// dead-man check, one acting firing per slot, and event-triggered scheduling.
// Ports only: ctx = { db, now(), config, fetch?, ai?({model,prompt,max_tokens}), bindings?: {name: db}, executor?(msg),
//                     deployed?: { list() }, claims? (core/claims module), claimsCtx? }. No platform imports.

export const VERSION = '0.1.0';

const DEFAULTS = {
  worker: 'fleet', scheduler_name: 'dispatcher', queued_ttl_minutes: 15, running_ttl_minutes: 60,
  max_tokens: 1024, allowed_models: [], reconcile_every_minutes: 60, deadman_window_minutes: 60,
  tick_procedure: null, tick_scheduler: 'platform-cron', alert_role: 'operations', result_chars: 4000, error_chars: 1000,
};
export const cfg = ctx => ({ ...DEFAULTS, ...(ctx.config || {}) });
export const TRIGGERS = ['cron', 'http', 'event', 'manual'];
export const TASK_TYPES = ['sql', 'http', 'ai', 'workflow'];
export const BUCKETS = ['executed', 'failed', 'needs_human', 'no_action'];

export function nowMs(ctx) {
  const v = ctx.now();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') return Date.parse(v.includes('T') ? v : v.replace(' ', 'T') + 'Z');
  return v;
}
export const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
export const parseIso = s => Date.parse(String(s).replace(' ', 'T') + 'Z');
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
const msg = e => String((e && e.message) || e);
const slug = s => String(s).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

async function openItem(ctx, id, title, doneCheck, probe, priority) {
  const r = await run(ctx.db, `INSERT OR IGNORE INTO items (id,title,kind,owner_role,done_check,closing_probe,priority,status) VALUES (?,?,'fix',?,?,?,?,'open')`,
    id, String(title).slice(0, 300), cfg(ctx).alert_role, doneCheck, probe, priority);
  return r.meta.changes > 0;
}

// ---- cron (US-SPEC-11 section 5) ---------------------------------------------------------------

const MINUTE = 60000;
const INT = /^\d+$/;
function matchTerm(term, v) {
  if (term === '*') return true;
  let m = /^\*\/(\d+)$/.exec(term);
  if (m) return Number(m[1]) > 0 && v % Number(m[1]) === 0;
  m = /^(\d+)-(\d+)$/.exec(term);
  if (m) return v >= Number(m[1]) && v <= Number(m[2]);
  return INT.test(term) && Number(term) === v;
}
const TERM = /^(\*|\*\/[1-9]\d*|\d+-\d+|\d+)$/;
export function matchField(field, v) { return String(field).split(',').some(t => matchTerm(t, v)); }
export function parseCron(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5 || !f.every(x => x.split(',').every(t => TERM.test(t)))) return null;
  return f;
}
function matches(f, t) {
  const d = new Date(t), dow = d.getUTCDay();
  return matchField(f[0], d.getUTCMinutes()) && matchField(f[1], d.getUTCHours()) && matchField(f[2], d.getUTCDate())
    && matchField(f[3], d.getUTCMonth() + 1) && (matchField(f[4], dow) || (dow === 0 && matchField(f[4], 7)));
}
/** The first matching minute strictly after `fromMs` (UTC), or null for a bad expression or no match in 366 days. */
export function nextFire(expr, fromMs) {
  const f = parseCron(expr);
  if (!f) return null;
  let t = Math.floor(fromMs / MINUTE) * MINUTE + MINUTE;
  for (let i = 0; i < 527040; i++, t += MINUTE) if (matches(f, t)) return t;
  return null;
}
/** Slot start times of `expr` with fromMs <= start < toMs. */
export function expectedSlots(expr, fromMs, toMs) {
  const out = [];
  for (let t = nextFire(expr, fromMs - MINUTE); t !== null && t < toMs; t = nextFire(expr, t)) out.push(t);
  return out;
}
/** US-11-R12: minutes in the window where more than one enabled schedule fires. */
export async function collisions(ctx, { from, to } = {}) {
  const end = to ?? nowMs(ctx) + 60 * MINUTE, start = from ?? end - 60 * MINUTE;
  const per = new Map();
  for (const c of await all(ctx.db, `SELECT name, expr FROM fleet_crons WHERE enabled = 1 ORDER BY name`))
    for (const t of expectedSlots(c.expr, start, end)) per.set(t, [...(per.get(t) || []), c.name]);
  const minutes = [...per.entries()].filter(([, n]) => n.length > 1).sort((a, b) => a[0] - b[0]).map(([t, names]) => ({ minute: iso(t), names }));
  return { from: iso(start), to: iso(end), fired_minutes: per.size, collisions: minutes.length, max_per_minute: Math.max(0, ...[...per.values()].map(n => n.length)), minutes };
}

// ---- schedule and task rows (US-11-R04) --------------------------------------------------------

export async function setCron(ctx, { name, expr, task_id, enabled = true }) {
  if (!parseCron(expr)) throw new Error('cron expression must have five valid fields');
  await run(ctx.db, `INSERT INTO fleet_crons (name, expr, task_id, enabled) VALUES (?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET expr=excluded.expr, task_id=excluded.task_id, enabled=excluded.enabled,
      next_fire = CASE WHEN fleet_crons.expr = excluded.expr THEN fleet_crons.next_fire ELSE NULL END`, name, expr, task_id, enabled ? 1 : 0);
}
export async function setTask(ctx, { id, type, definition = {}, enabled = true }) {
  await run(ctx.db, `INSERT INTO fleet_tasks (id, type, definition, enabled) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET type=excluded.type, definition=excluded.definition, enabled=excluded.enabled`, id, String(type), JSON.stringify(definition), enabled ? 1 : 0);
}
export async function declareProcedure(ctx, { name, expr, schedulers }) {
  if (!parseCron(expr)) throw new Error('cron expression must have five valid fields');
  if (!Array.isArray(schedulers) || !schedulers.length) throw new Error('a procedure names at least one scheduler');
  await run(ctx.db, `INSERT INTO fleet_procedures (name, expr, schedulers) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET expr=excluded.expr, schedulers=excluded.schedulers`,
    name, expr, JSON.stringify(schedulers));
}

// ---- dispatcher (US-11-R03, R04, R11) ----------------------------------------------------------

async function post(ctx, m) {
  if (typeof ctx.executor !== 'function') throw new Error('no executor configured');
  const r = await ctx.executor(m);
  if (r && r.ok === false && r.rejected_before_start) throw new Error(r.error || 'executor refused');
  return r;
}

/** One dispatcher invocation: fire every due row, advance next_fire and last_fired whether or not the post succeeded. */
export async function dispatch(ctx) {
  const c = cfg(ctx), now = nowMs(ctx), nowS = iso(now);
  const out = { fired: [], skipped: [], errors: [] };
  const due = await all(ctx.db, `SELECT * FROM fleet_crons WHERE enabled = 1 AND (next_fire IS NULL OR next_fire <= ?) ORDER BY name`, nowS);
  for (const cr of due) {
    const nf = nextFire(cr.expr, now);
    // US-11-R11: one live run per task. A queued or running row for the task means this firing is not dispatched.
    const live = await first(ctx.db, `SELECT run_id FROM fleet_runs WHERE task_id = ? AND status IN ('queued','running')`, cr.task_id);
    let runId = null, error = null;
    if (live) out.skipped.push({ cron: cr.name, reason: 'overlap', run_id: live.run_id });
    else {
      const ins = await run(ctx.db, `INSERT INTO fleet_runs (worker, trigger, status, task_id, cron_name, scheduler, queued_at, evidence_refs) VALUES (?, 'cron', 'queued', ?, ?, ?, ?, '[]')`,
        c.worker, cr.task_id, cr.name, c.scheduler_name, nowS);
      runId = ins.meta.last_row_id;
      try { await post(ctx, { task_id: cr.task_id, cron_name: cr.name, run_id: runId }); out.fired.push({ cron: cr.name, run_id: runId }); }
      catch (e) { error = msg(e).slice(0, 300); out.errors.push({ cron: cr.name, run_id: runId, error }); }
    }
    await run(ctx.db, `UPDATE fleet_crons SET last_fired = ?, next_fire = ? WHERE name = ?`, nowS, nf === null ? null : iso(nf), cr.name);
    if (nf === null) await run(ctx.db, `UPDATE fleet_crons SET enabled = 0 WHERE name = ?`, cr.name); // an expression that never fires must not be due every minute
  }
  return out;
}

/** Stale `queued` and `running` rows end as failed with an alert item, so a silent executor is visible (US-11-R11). */
export async function reapStale(ctx) {
  const c = cfg(ctx), now = nowMs(ctx), nowS = iso(now), reaped = [];
  const rows = [
    ...await all(ctx.db, `SELECT run_id, cron_name, task_id, 'stale_queued' AS cls FROM fleet_runs WHERE status = 'queued' AND queued_at <= ?`, iso(now - c.queued_ttl_minutes * MINUTE)),
    ...await all(ctx.db, `SELECT run_id, cron_name, task_id, 'stale_running' AS cls FROM fleet_runs WHERE status = 'running' AND ts_start <= ?`, iso(now - c.running_ttl_minutes * MINUTE)),
  ];
  for (const r of rows) {
    const u = await run(ctx.db, `UPDATE fleet_runs SET status = 'failed', error_class = ?, error = ?, ts_end = ? WHERE run_id = ? AND status IN ('queued','running')`,
      r.cls, r.cls === 'stale_queued' ? 'never left queued: the executor did not take the run' : 'never finished', nowS, r.run_id);
    if (!u.meta.changes) continue;
    reaped.push(r.run_id);
    await openItem(ctx, `FLEET-STALE-${slug(r.task_id || r.run_id)}`, `Task ${r.task_id} has runs that ${r.cls === 'stale_queued' ? 'never left queued' : 'never finished'} (first: run ${r.run_id})`,
      `the next run of task ${r.task_id} ends ok`, `fleet_runs: newest row for task ${r.task_id} has status ok`, 20);
  }
  return { reaped };
}

// ---- event envelopes (US-11-R06) ---------------------------------------------------------------

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export async function buildEnvelope({ kind, id, ts, emitter, session, payload }) {
  return { schema_version: '1', kind, id, ts, provenance: { emitter, session, sha256: await sha256Hex(JSON.stringify(payload ?? null)) } };
}
/** Returns null when valid, else the reason. The payload hash is recomputed, never trusted. */
export async function validateEnvelope(env, payload) {
  if (!env || typeof env !== 'object') return 'envelope missing';
  if (env.schema_version !== '1') return 'unsupported schema_version';
  if (typeof env.kind !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,80}$/.test(env.kind)) return 'kind missing or malformed';
  if (typeof env.id !== 'string' || !env.id || env.id.length > 200) return 'id missing';
  if (typeof env.ts !== 'string' || Number.isNaN(parseIso(env.ts))) return 'ts missing or unparsable';
  const p = env.provenance;
  if (!p || typeof p !== 'object') return 'provenance missing';
  if (typeof p.emitter !== 'string' || !p.emitter) return 'provenance.emitter missing';
  if (typeof p.session !== 'string' || !p.session) return 'provenance.session missing';
  if (typeof p.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.sha256)) return 'provenance.sha256 missing or malformed';
  if (p.sha256 !== await sha256Hex(JSON.stringify(payload ?? null))) return 'provenance.sha256 does not match the payload';
  return null;
}
export async function recordEvent(ctx, env, payload, { run_id = null } = {}) {
  let error = await validateEnvelope(env, payload);
  const e = env && typeof env === 'object' ? env : {}, p = e.provenance && typeof e.provenance === 'object' ? e.provenance : {};
  const str = v => (typeof v === 'string' ? v.slice(0, 200) : null);
  const body = JSON.stringify(payload ?? null).slice(0, 4000);
  const put = (state, err) => run(ctx.db, `INSERT INTO fleet_events (event_id, schema_version, kind, ts, emitter, session, payload_sha256, payload, state, error, run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    str(e.id), str(e.schema_version), str(e.kind), str(e.ts), str(p.emitter), str(p.session), str(p.sha256), body, state, err, run_id);
  if (!error) {
    try { await put('accepted', null); return { accepted: true, id: e.id }; }
    catch (x) { if (!/UNIQUE|constraint/i.test(msg(x))) throw x; error = 'duplicate event id'; }
  }
  await put('rejected', error);
  return { accepted: false, error };
}

// ---- executor (US-11-R05, R06) -----------------------------------------------------------------

class TaskError extends Error { constructor(cls, m) { super(m); this.cls = cls; } }

async function runSql(ctx, def) {
  const db = def.binding ? (ctx.bindings || {})[def.binding] : ctx.db;
  if (!db) throw new TaskError('no_binding', `binding ${def.binding} is not configured`);
  const s = String(def.statement || '').trim().replace(/;\s*$/, '');
  if (!s || s.includes(';')) throw new TaskError('bad_definition', 'sql task takes exactly one statement');
  const st = db.prepare(s).bind(...(Array.isArray(def.params) ? def.params : []));
  if (/^(select|with)\b/i.test(s)) { const rows = (await st.all()).results || []; return { row_count: rows.length, rows: rows.slice(0, 3) }; }
  return { row_count: (await st.run()).meta.changes };
}
async function runHttp(ctx, def) {
  if (typeof ctx.fetch !== 'function') throw new TaskError('no_fetch', 'no fetch port');
  if (!def.url) throw new TaskError('bad_definition', 'http task needs a url');
  const r = await ctx.fetch(def.url, { method: def.method || 'GET', headers: def.headers || {}, body: def.body == null ? undefined : (typeof def.body === 'string' ? def.body : JSON.stringify(def.body)) });
  const text = (await r.text()).slice(0, 500);
  if (r.status >= 400) throw new TaskError('http_status', `status ${r.status}: ${text}`);
  return { status: r.status, body: text };
}
/** The model must be on the allowed list; with none named, the cheapest allowed model is used. */
export function chooseModel(c, wanted) {
  const list = (c.allowed_models || []).map(m => (typeof m === 'string' ? { id: m, cost: 0 } : m));
  if (!list.length) throw new TaskError('no_model', 'no allowed models configured');
  if (wanted) { const m = list.find(x => x.id === wanted); if (!m) throw new TaskError('model_not_allowed', `model ${wanted} is not on the allowed list`); return m; }
  return list.reduce((a, b) => (Number(b.cost) < Number(a.cost) ? b : a));
}
async function runAi(ctx, def) {
  const c = cfg(ctx);
  if (typeof ctx.ai !== 'function') throw new TaskError('no_gateway', 'no model gateway port');
  const model = chooseModel(c, def.model);
  const max_tokens = Math.max(1, Math.min(Number(def.max_tokens) > 0 ? Number(def.max_tokens) : c.max_tokens, c.max_tokens));
  const r = await ctx.ai({ model: model.id, prompt: String(def.prompt || ''), max_tokens });
  return { model: model.id, max_tokens, text: String((r && r.text) ?? '').slice(0, 2000), cost: Number(r && r.cost) || 0 };
}
const SIMPLE = { sql: runSql, http: runHttp, ai: runAi };
async function runTask(ctx, type, def) {
  if (SIMPLE[type]) return SIMPLE[type](ctx, def || {});
  if (type === 'workflow') {
    const steps = Array.isArray(def && def.steps) ? def.steps : null;
    if (!steps || !steps.length) throw new TaskError('bad_definition', 'workflow needs a non-empty steps list');
    const results = []; let cost = 0;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i] || {};
      if (!SIMPLE[s.type]) throw new TaskError('unknown_type', `workflow step ${i + 1} has unknown type ${s.type}`);
      try { const r = await SIMPLE[s.type](ctx, s.definition || {}); cost += Number(r.cost) || 0; results.push({ step: i + 1, type: s.type, ...r }); }
      catch (e) { throw new TaskError(e.cls || 'exception', `workflow step ${i + 1} (${s.type}): ${msg(e)}`); }
    }
    return { steps: results, cost };
  }
  throw new TaskError('unknown_type', `unknown task type ${type}`);
}

/**
 * Execute one task and write its run record. m = { task_id, cron_name?, run_id?, trigger?, parent_run?, session?, task? }.
 * `task` (an inline {type, definition}) is for posted tasks; every execution, accepted or rejected, ends in a run row.
 */
export async function execute(ctx, m = {}) {
  const c = cfg(ctx), startS = iso(nowMs(ctx));
  const trigger = m.run_id ? null : (m.trigger || 'http');
  if (trigger && !TRIGGERS.includes(trigger)) return { ok: false, rejected_before_start: true, error: `unknown trigger ${trigger}` };
  let runId = m.run_id;
  if (runId) {
    const u = await run(ctx.db, `UPDATE fleet_runs SET status = 'running', ts_start = ? WHERE run_id = ? AND status = 'queued'`, startS, runId);
    if (!u.meta.changes) return { ok: false, rejected_before_start: true, run_id: runId, error: 'run is not queued (already taken or reaped)' };
  } else {
    const ins = await run(ctx.db, `INSERT INTO fleet_runs (worker, trigger, ts_start, status, task_id, cron_name, parent_run, queued_at, evidence_refs) VALUES (?,?,?, 'running', ?,?,?,?, '[]')`,
      c.worker, trigger, startS, m.task_id ?? (m.task ? 'inline' : null), m.cron_name ?? null, m.parent_run ?? null, startS);
    runId = ins.meta.last_row_id;
  }
  let status = 'ok', result = null, error = null, cls = null, type = null;
  try {
    let task = m.task || null;
    if (!task) {
      const row = await first(ctx.db, `SELECT * FROM fleet_tasks WHERE id = ?`, m.task_id ?? '');
      if (!row) throw new TaskError('no_task', `task ${m.task_id} not found`);
      if (!row.enabled) throw new TaskError('task_disabled', `task ${m.task_id} is disabled`);
      let definition;
      try { definition = JSON.parse(row.definition); } catch { throw new TaskError('bad_definition', 'task definition is not JSON'); }
      task = { type: row.type, definition };
    }
    type = task.type;
    if (!TASK_TYPES.includes(type)) throw new TaskError('unknown_type', `unknown task type ${type}`);
    result = await runTask(ctx, type, task.definition);
  } catch (e) { status = 'failed'; cls = e.cls || 'exception'; error = msg(e).slice(0, c.error_chars); }
  const endS = iso(nowMs(ctx));
  const resultText = result === null ? null : JSON.stringify(result).slice(0, c.result_chars);
  const summary = status === 'ok' ? `${type} task ${m.task_id ?? 'inline'} ok` : `${type ?? 'task'} ${m.task_id ?? 'inline'} failed: ${cls}`;
  const payload = { run_id: runId, task_id: m.task_id ?? null, type, status, error_class: cls };
  const env = await buildEnvelope({ kind: 'fleet.run', id: `run-${runId}`, ts: endS, emitter: c.worker, session: String(m.session || `run-${runId}`), payload });
  const ev = await recordEvent(ctx, env, payload, { run_id: runId });
  await run(ctx.db, `UPDATE fleet_runs SET status = ?, ts_end = ?, error_class = ?, summary = ?, result = ?, error = ?, cost = ?, evidence_refs = ? WHERE run_id = ?`,
    status, endS, cls, summary, resultText, error, Number(result && result.cost) || 0, JSON.stringify([`fleet_events:run-${runId}:${ev.accepted ? 'accepted' : 'rejected'}`]), runId);
  return { ok: status === 'ok', run_id: runId, status, error_class: cls, error, result, event: ev };
}

// ---- accounting invariant as a gate (US-11-R07) ------------------------------------------------

const cnt = v => (Array.isArray(v) ? v.length : Number(v) || 0);
/** Book one batch. A gap makes the batch a failure, fails its run row, opens an incident item and closes the gate. */
export async function recordBatch(ctx, b = {}) {
  const ids = Array.isArray(b.scanned_ids) ? b.scanned_ids : null;
  const scanned = ids ? ids.length : cnt(b.scanned);
  const gap = scanned - BUCKETS.reduce((s, k) => s + cnt(b[k]), 0);
  let unaccounted = null;
  if (ids && BUCKETS.every(k => b[k] === undefined || Array.isArray(b[k]))) { const seen = new Set(BUCKETS.flatMap(k => b[k] || [])); unaccounted = ids.filter(i => !seen.has(i)); }
  const at = iso(nowMs(ctx)), executor = String(b.executor || 'executor'), status = gap === 0 ? 'ok' : 'failed';
  const ins = await run(ctx.db, `INSERT INTO fleet_batches (at, executor, run_id, scanned, executed, failed, needs_human, no_action, gap, status, unaccounted) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    at, executor, b.run_id ?? null, scanned, cnt(b.executed), cnt(b.failed), cnt(b.needs_human), cnt(b.no_action), gap, status, unaccounted ? JSON.stringify(unaccounted) : null);
  const out = { ok: gap === 0, batch_id: ins.meta.last_row_id, scanned, gap, status, unaccounted: unaccounted || [], item_id: null };
  if (gap === 0) return out;
  if (b.run_id) await run(ctx.db, `UPDATE fleet_runs SET status = 'failed', error_class = 'accounting_gap', error = ? WHERE run_id = ?`, `scanned ${scanned}, accounted ${scanned - gap}`, b.run_id);
  out.item_id = `FLEET-UNACCOUNTED-${slug(executor)}`;
  await openItem(ctx, out.item_id, `Executor ${executor} scanned ${scanned} and accounted for ${scanned - gap}`,
    `the next batch of ${executor} balances: executed + failed + needs_human + no_action = scanned`, `fleet_batches: newest row for executor ${executor} has gap 0`, 0);
  return out;
}
/** The gate: an executor whose newest batch does not balance is not passed. Consumers call this before trusting its output. */
export async function batchGate(ctx, executor) {
  const last = await first(ctx.db, `SELECT * FROM fleet_batches WHERE executor = ? ORDER BY id DESC LIMIT 1`, String(executor));
  if (!last) return { pass: true, reason: 'no_batches' };
  return last.gap === 0 ? { pass: true, batch_id: last.id } : { pass: false, reason: 'accounting_gap', batch_id: last.id, gap: last.gap, unaccounted: JSON.parse(last.unaccounted || '[]') };
}
/** Drain a batch booking exactly one bucket per item. A handler that throws books `failed`; any other answer is unaccounted. */
export async function drain(ctx, { executor, items, handle, run_id = null }) {
  const b = { executor, run_id, scanned_ids: items.map(i => i.id), executed: [], failed: [], needs_human: [], no_action: [] };
  for (const it of items) {
    let bucket;
    try { bucket = await handle(it); } catch { bucket = 'failed'; }
    if (BUCKETS.includes(bucket)) b[bucket].push(it.id);
  }
  return recordBatch(ctx, b);
}

// ---- one acting firing per slot (US-11-R10) ----------------------------------------------------

/**
 * Run `fn` at most once per (procedure, slot). The winner takes the slot row (a store-enforced claim) and, when the claims
 * port is present, a US-SPEC-08 work claim for the duration. The other firing writes a run record and ends without acting.
 */
export async function fireOnce(ctx, { procedure, scheduler, expr = null, trigger = 'cron' }, fn) {
  const c = cfg(ctx), now = nowMs(ctx), nowS = iso(now);
  let slot = Math.floor(now / MINUTE) * MINUTE; // without an expression the slot is the current minute
  if (expr) { const f = parseCron(expr); if (!f) throw new Error('bad cron expression'); for (let i = 0; i < 527040 && !matches(f, slot); i++) slot -= MINUTE; }
  const slotS = iso(slot);
  const record = (status, summary, cls = null, error = null) => run(ctx.db,
    `INSERT INTO fleet_runs (worker, trigger, ts_start, ts_end, status, error_class, summary, cron_name, scheduler, queued_at, evidence_refs, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    c.worker, trigger, nowS, iso(nowMs(ctx)), status, cls, summary, procedure, scheduler, nowS, JSON.stringify([`fleet_slot_claims:${procedure}:${slotS}`]), error);
  const won = (await run(ctx.db, `INSERT OR IGNORE INTO fleet_slot_claims (procedure, slot, scheduler, at) VALUES (?,?,?,?)`, procedure, slotS, scheduler, nowS)).meta.changes > 0;
  if (!won) { await record('ok', 'duplicate firing: the slot was already taken, ended without acting'); return { acted: false, slot: slotS, reason: 'slot_taken' }; }
  let claim = null;
  if (ctx.claims) {
    claim = await ctx.claims.acquire(ctx.claimsCtx || ctx, { key: `procedure:${procedure}`, holder: scheduler, intent: `fire ${procedure} ${slotS}`, allow_duplicate: true });
    if (!claim.acquired) { await record('ok', `duplicate firing: work claim held by ${claim.holder || 'another'}, ended without acting`); return { acted: false, slot: slotS, reason: claim.reason }; }
  }
  try {
    const result = await fn({ slot: slotS });
    await record('ok', `${procedure} acted for slot ${slotS}`);
    return { acted: true, slot: slotS, result };
  } catch (e) {
    await record('failed', `${procedure} failed for slot ${slotS}`, 'exception', msg(e).slice(0, c.error_chars));
    return { acted: true, slot: slotS, error: msg(e) };
  } finally {
    if (claim) await ctx.claims.release(ctx.claimsCtx || ctx, { key: `procedure:${procedure}`, token: claim.token, outcome: 'done' });
  }
}

// ---- dead-man check (US-11-R08, R09) -----------------------------------------------------------

/**
 * For each declared procedure: expected slots from its cron expression, records per slot and per scheduler, an alert for
 * each fully elapsed slot with no record (`stop`), and a `single_path` label where one of several declared schedulers is silent.
 */
export async function deadman(ctx, { from, to } = {}) {
  const c = cfg(ctx), now = nowMs(ctx);
  const end = to ?? now, start = from ?? end - c.deadman_window_minutes * MINUTE;
  const out = { from: iso(start), to: iso(end), procedures: [], alerts: [] };
  for (const p of await all(ctx.db, `SELECT * FROM fleet_procedures ORDER BY name`)) {
    const declared = JSON.parse(p.schedulers);
    const slots = expectedSlots(p.expr, start, end).map(s => ({ start: s, end: nextFire(p.expr, s) })).filter(s => s.end !== null && s.end <= now);
    const rel = Object.fromEntries(declared.map(s => [s, { slots: slots.length, with_record: 0 }]));
    const row = { procedure: p.name, slots: slots.length, stops: 0, single_path: 0, reliability: {} };
    for (const s of slots) {
      const a = iso(s.start), b = iso(s.end);
      const recs = await all(ctx.db, `SELECT COALESCE(scheduler, '') AS scheduler, COUNT(*) AS n FROM fleet_runs WHERE cron_name = ? AND ts_start >= ? AND ts_start < ? GROUP BY 1`, p.name, a, b);
      const by = new Map(recs.map(r => [r.scheduler, r.n]));
      if (c.tick_procedure === p.name) {
        const t = await first(ctx.db, `SELECT COUNT(*) AS n FROM tick_runs WHERE started_at >= ? AND started_at < ?`, a, b);
        if (t.n) by.set(c.tick_scheduler, (by.get(c.tick_scheduler) || 0) + t.n);
      }
      const total = [...by.values()].reduce((x, y) => x + y, 0);
      const missing = declared.filter(d => !by.get(d));
      for (const d of declared) if (by.get(d)) rel[d].with_record++;
      let kind = null;
      if (total === 0) kind = 'stop';
      else if (declared.length > 1 && missing.length > 0) kind = 'single_path';
      if (!kind) continue;
      row[kind === 'stop' ? 'stops' : 'single_path']++;
      const priority = kind === 'stop' ? 0 : 60;
      const itemId = kind === 'stop' ? `DEADMAN-${slug(p.name)}-${a.replace(/[- :]/g, '').slice(0, 12)}` : `FLEET-PATH-${slug(p.name)}-${slug(missing.join('-'))}`;
      const ins = await run(ctx.db, `INSERT OR IGNORE INTO fleet_alerts (procedure, slot, kind, schedulers, missing, priority, item_id, at) VALUES (?,?,?,?,?,?,?,?)`,
        p.name, a, kind, p.schedulers, JSON.stringify(missing), priority, itemId, iso(now));
      if (!ins.meta.changes) continue;
      if (kind === 'stop') await openItem(ctx, itemId, `Stop: procedure ${p.name} has no record for slot ${a} (declared by ${declared.join(', ')})`,
        `a later slot of ${p.name} has a record`, `fleet_runs: a row for ${p.name} with ts_start after ${a}`, priority);
      else await openItem(ctx, itemId, `Single-path failure: ${missing.join(', ')} produced no record for ${p.name} (first seen slot ${a}); redundancy is degraded`,
        `${missing.join(', ')} records every slot of ${p.name} for one window`, `fleet deadman: reliability of ${missing.join(', ')} for ${p.name} is 1`, priority);
      out.alerts.push({ procedure: p.name, slot: a, kind, schedulers: declared, missing, priority, item_id: itemId });
    }
    for (const d of declared) row.reliability[d] = rel[d].slots ? rel[d].with_record / rel[d].slots : null;
    out.procedures.push(row);
  }
  return out;
}

// ---- worker contract and registry reconciliation (US-11-R01, R02) ------------------------------

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const HEALTH_FIELDS = ['status', 'worker', 'version', 'enabled', 'bindings_ok'];
const HEADER_FIELDS = ['purpose', 'capabilities', 'deploy_method', 'canonical_source'];
const REGISTRY_FIELDS = ['name', 'purpose', 'kind', 'status', 'crons', 'dependencies', 'health_url', 'autonomy_level', 'owner'];
const parseJson = (s, d) => { if (s == null) return d; if (typeof s !== 'string') return s; try { return JSON.parse(s); } catch { return d; } };

/** The seven parts of the worker contract (section 4). Returns the list of unmet parts; empty means the member conforms. */
export function contractGaps(reg, deployed = null) {
  const gaps = [], r = reg || {};
  if (!SEMVER.test(String(r.version || ''))) gaps.push('1 version: no semantic VERSION');
  if (deployed) { const h = deployed.health || {}; const miss = HEALTH_FIELDS.filter(f => !(f in h)); if (miss.length) gaps.push(`2 health: missing ${miss.join(', ')}`); }
  const header = parseJson(r.header, null) || {};
  const hm = HEADER_FIELDS.filter(f => header[f] == null || header[f] === '' || (Array.isArray(header[f]) && !header[f].length));
  if (hm.length) gaps.push(`3 header: missing ${hm.join(', ')}`);
  if (!/^[0-9a-f]{64}$/.test(String(r.source_hash || ''))) gaps.push('4 canonical source: no SHA-256 of the deployed source');
  const rm = REGISTRY_FIELDS.filter(f => r[f] == null || r[f] === '');
  if (rm.length) gaps.push(`5 registry row: missing ${rm.join(', ')}`);
  const names = parseJson(r.secret_names, null);
  if (!Array.isArray(names) || names.some(n => typeof n !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) gaps.push('6 secrets: must be a list of names (identifiers), never values');
  if (!r.flags_source) gaps.push('7 flags: no readable kill-switch and autonomy flag source');
  return gaps;
}
export async function register(ctx, w) {
  const names = w.secret_names || [];
  if (!Array.isArray(names) || names.some(n => typeof n !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) throw new Error('secret_names takes names only, never values');
  const j = v => JSON.stringify(v ?? []);
  await run(ctx.db, `INSERT INTO fleet_registry (name,purpose,kind,status,crons,dependencies,health_url,autonomy_level,owner,version,source_hash,header,secret_names,flags_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET purpose=excluded.purpose, kind=excluded.kind, status=excluded.status, crons=excluded.crons, dependencies=excluded.dependencies, health_url=excluded.health_url,
      autonomy_level=excluded.autonomy_level, owner=excluded.owner, version=excluded.version, source_hash=excluded.source_hash, header=excluded.header, secret_names=excluded.secret_names, flags_source=excluded.flags_source`,
    w.name, w.purpose ?? null, w.kind ?? null, w.status || 'active', j(w.crons), j(w.dependencies), w.health_url ?? null, w.autonomy_level ?? null, w.owner ?? null,
    w.version ?? null, w.source_hash ?? null, w.header ? JSON.stringify(w.header) : null, j(names), w.flags_source ?? null);
}

/**
 * Reconcile deployed reality against the registry. `ctx.deployed.list()` returns [{ name, version?, source_hash?, health? }]
 * read from the platform (an adapter). Each registered worker ends in exactly one state; the three drift counts are reported.
 */
export async function reconcile(ctx) {
  if (!ctx.deployed || typeof ctx.deployed.list !== 'function') return { ok: false, reason: 'no_deployed_port' };
  const at = iso(nowMs(ctx));
  const deployed = new Map((await ctx.deployed.list()).map(d => [d.name, d]));
  const reg = await all(ctx.db, `SELECT * FROM fleet_registry ORDER BY name`);
  const counts = { live: 0, drifted: 0, degraded: 0, paused: 0, retired: 0 };
  const ghosts = [], unversioned = [], states = {}, contract = {};
  for (const r of reg) {
    const d = deployed.get(r.name) || null;
    let state, detail = null;
    if (r.status === 'retired') { state = 'retired'; if (d) detail = 'retired in the registry but still deployed'; }
    else if (!d) { state = 'degraded'; detail = 'registered, not deployed'; ghosts.push(r.name); }
    else {
      const h = d.health || {}, dv = d.version || h.version || null;
      if (!dv) unversioned.push(r.name);
      if (r.status === 'paused' || h.enabled === false) state = 'paused';
      else if (h.status !== 'ok' || h.bindings_ok === false) { state = 'degraded'; detail = `health status ${h.status ?? 'missing'}, bindings_ok ${h.bindings_ok ?? 'missing'}`; }
      else if (!dv) { state = 'drifted'; detail = 'deployed without a version: cannot be compared'; }
      else if (dv !== r.version) { state = 'drifted'; detail = `deployed ${dv}, registry ${r.version ?? 'none'}`; }
      else if (r.source_hash && d.source_hash && r.source_hash !== d.source_hash) { state = 'drifted'; detail = 'deployed source differs from the canonical copy'; }
      else state = 'live';
    }
    counts[state]++; states[r.name] = state;
    const gaps = contractGaps(r, d);
    if (gaps.length) contract[r.name] = gaps;
    await run(ctx.db, `UPDATE fleet_registry SET state = ?, state_detail = ?, checked_at = ? WHERE name = ?`, state, detail, at, r.name);
    if (state === 'drifted' || (state === 'degraded' && r.status !== 'retired'))
      await openItem(ctx, `FLEET-${state.toUpperCase()}-${slug(r.name)}`, `Worker ${r.name} is ${state}: ${detail}`, `registry reconciliation reports ${r.name} live`, `fleet_registry.state = live for ${r.name}`, state === 'degraded' ? 10 : 20);
  }
  const known = new Set(reg.map(r => r.name));
  const unregistered = [...deployed.keys()].filter(n => !known.has(n)).sort();
  for (const n of unregistered) {
    if (!(deployed.get(n).version || (deployed.get(n).health || {}).version)) unversioned.push(n);
    await openItem(ctx, `FLEET-UNREGISTERED-${slug(n)}`, `Deployed worker ${n} has no registry row`, `${n} is registered or removed`, `fleet_registry has a row for ${n}, or it is no longer deployed`, 20);
  }
  const detail = { ghosts, unregistered, unversioned, contract };
  await run(ctx.db, `INSERT INTO fleet_reconciliations (at, live, drifted, degraded, paused, retired, ghosts, unregistered, unversioned, detail) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    at, counts.live, counts.drifted, counts.degraded, counts.paused, counts.retired, ghosts.length, unregistered.length, unversioned.length, JSON.stringify(detail));
  return { ok: true, at, counts, states, ...detail };
}

// ---- event-triggered scheduling ----------------------------------------------------------------

export async function setTrigger(ctx, { id, event_kind, task_id, enabled = true }) {
  await run(ctx.db, `INSERT INTO fleet_triggers (id, event_kind, task_id, enabled) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET event_kind=excluded.event_kind, task_id=excluded.task_id, enabled=excluded.enabled`, id, event_kind, task_id, enabled ? 1 : 0);
}
/**
 * Accept an event and start every task triggered by its kind. The envelope is validated first; a rejected or repeated
 * event starts nothing. Each started run is a `queued` row with trigger `event`, posted to the executor.
 */
export async function emit(ctx, env, payload) {
  const ev = await recordEvent(ctx, env, payload);
  const out = { accepted: ev.accepted, error: ev.error || null, started: [], skipped: [], errors: [] };
  if (!ev.accepted) return out;
  const c = cfg(ctx), nowS = iso(nowMs(ctx));
  for (const t of await all(ctx.db, `SELECT * FROM fleet_triggers WHERE enabled = 1 AND event_kind = ? ORDER BY id`, env.kind)) {
    const live = await first(ctx.db, `SELECT run_id FROM fleet_runs WHERE task_id = ? AND status IN ('queued','running')`, t.task_id);
    if (live) { out.skipped.push({ trigger: t.id, reason: 'overlap', run_id: live.run_id }); continue; }
    const ins = await run(ctx.db, `INSERT INTO fleet_runs (worker, trigger, status, task_id, scheduler, queued_at, evidence_refs, summary) VALUES (?, 'event', 'queued', ?, ?, ?, ?, ?)`,
      c.worker, t.task_id, `event:${t.id}`, nowS, JSON.stringify([`fleet_events:${env.id}`]), `started by event ${env.kind}`);
    const runId = ins.meta.last_row_id;
    try { await post(ctx, { task_id: t.task_id, run_id: runId, session: env.provenance.session }); out.started.push({ trigger: t.id, run_id: runId }); }
    catch (e) { out.errors.push({ trigger: t.id, run_id: runId, error: msg(e).slice(0, 300) }); }
  }
  return out;
}

// ---- surface for the composition root ----------------------------------------------------------

/** GET /health body of the worker contract. `bindings_ok` is a real read of the store. */
export async function health(ctx) {
  const c = cfg(ctx);
  let bindings_ok = true;
  try { await first(ctx.db, `SELECT COUNT(*) AS n FROM fleet_runs`); } catch { bindings_ok = false; }
  const enabled = c.enabled !== false;
  return { status: bindings_ok ? 'ok' : 'degraded', worker: c.worker, version: VERSION, enabled, bindings_ok };
}
export async function status(ctx) {
  const n = async (sql, ...a) => (await first(ctx.db, sql, ...a)).n;
  const last = await first(ctx.db, `SELECT * FROM fleet_reconciliations ORDER BY id DESC LIMIT 1`);
  return {
    runs: Object.fromEntries((await all(ctx.db, `SELECT status, COUNT(*) AS n FROM fleet_runs GROUP BY status`)).map(r => [r.status, r.n])),
    crons_enabled: await n(`SELECT COUNT(*) AS n FROM fleet_crons WHERE enabled = 1`),
    unbalanced_batches: await n(`SELECT COUNT(*) AS n FROM fleet_batches WHERE gap <> 0`),
    rejected_events: await n(`SELECT COUNT(*) AS n FROM fleet_events WHERE state = 'rejected'`),
    stop_alerts: await n(`SELECT COUNT(*) AS n FROM fleet_alerts WHERE kind = 'stop'`),
    single_path_alerts: await n(`SELECT COUNT(*) AS n FROM fleet_alerts WHERE kind = 'single_path'`),
    reconciliation: last ? { at: last.at, live: last.live, drifted: last.drifted, degraded: last.degraded, paused: last.paused, retired: last.retired, ghosts: last.ghosts, unregistered: last.unregistered, unversioned: last.unversioned } : null,
  };
}

/** One tick of the fleet runtime: dispatch due rows, reap stale runs, run the dead-man check, reconcile when due. */
export async function step(ctx) {
  const c = cfg(ctx);
  if (c.enabled === false) return { enabled: false };
  const out = { dispatch: await dispatch(ctx), reaped: (await reapStale(ctx)).reaped, deadman: (await deadman(ctx)).alerts.length };
  if (ctx.deployed) {
    const last = await first(ctx.db, `SELECT at FROM fleet_reconciliations ORDER BY id DESC LIMIT 1`);
    if (!last || nowMs(ctx) - parseIso(last.at) >= c.reconcile_every_minutes * MINUTE) { const r = await reconcile(ctx); out.reconcile = r.counts; }
  }
  return out;
}

const json = (body, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
/** Routes: GET /health, GET /fleet/status, POST /fleet/execute (authorized) for posted tasks and dispatcher posts. */
export async function handle(request, ctx) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') return json(await health(ctx));
  if (request.method === 'GET' && url.pathname === '/fleet/status') return json(await status(ctx));
  if (request.method === 'POST' && url.pathname === '/fleet/execute') {
    if (typeof ctx.authorize !== 'function' || !(await ctx.authorize(request))) return json({ error: 'unauthorized' }, 401);
    let body; try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const r = await execute(ctx, { ...body, trigger: body.run_id ? undefined : (body.trigger || 'http') });
    if (r.rejected_before_start) return json({ error: r.error }, 409);
    return json(r, r.error_class === 'unknown_type' ? 422 : 200);
  }
  return json({ error: 'not_found' }, 404);
}
