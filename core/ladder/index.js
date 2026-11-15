// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Model ladder persistence (US-SPEC-09 sections 4 and 5): the capability matrix and the admission pipeline that is the only
// way a matrix row is created, capability-first routing, the cascade with measured escalation, draft-then-verify (L6), shadow
// sampling, the demotion step and cost per verified outcome. Ports: db (D1-style), now (ms), and the model ports each
// function names (canary, run, validate, draft, repair). No provider is called here; core/router does that.

export const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);
export const ESCALATION_SIGNALS = ['schema', 'tool_call_parse', 'empty', 'truncation', 'low_confidence', 'provider_error'];
export const GATE_RANGE = [0.6, 0.85];

const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
const bit = (v) => (v === null || v === undefined ? null : v ? 1 : 0);

/** Wilson lower confidence bound of agree/n (z = 1.96 is the 95% bound). */
export function wilsonLower(agree, n, z = 1.96) {
  if (!n) return null;
  const p = agree / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

// ---- Floor ----

export async function setFloor(db, banned) {
  for (const b of banned) {
    new RegExp(b.pattern, 'i');
    await run(db, `INSERT INTO ladder_floor_banned (pattern, reason) VALUES (?,?) ON CONFLICT(pattern) DO UPDATE SET reason=excluded.reason`, b.pattern, b.reason);
  }
}
/** The reason a model is below the floor, or null. */
export async function floorViolation(db, model) {
  for (const b of await all(db, `SELECT pattern, reason FROM ladder_floor_banned ORDER BY pattern`)) {
    if (new RegExp(b.pattern, 'i').test(model)) return `${b.reason} (banned pattern ${b.pattern})`;
  }
  return null;
}

// ---- Admission pipeline (the only path by which a matrix row is created) ----

async function stageRow(db, c, stage, reason, nowIso, m = {}) {
  await run(db, `INSERT INTO ladder_model_admission (model, task_class, stage, n, agree, lower_bound, gate, decided_at, reason, evidence) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    c.model, c.task_class, stage, m.n ?? null, m.agree ?? null, m.lower_bound ?? null, m.gate ?? null, nowIso, reason, m.evidence ? JSON.stringify(m.evidence) : null);
}

/**
 * Admit a candidate model for a task class: floor check, capability canary, label agreement by lower confidence bound against
 * the class gate, then the rung row.
 *   c = { model, task_class, rung, unit_cost, ctx_tokens?, max_out?, need?: { tool_calls?, schema? }, decision?: boolean,
 *         canary: async () => ({ tool_calls, schema }), sample?: [{ label, answer }] | { n, agree }, gate? }
 * `decision: true` marks a model that will gate decisions: it needs agreement with the organization's labels (US-09-R12).
 * Returns { admitted, stage, reason, agree?, lower_bound? }.
 */
export async function admit(db, c, { now = Date.now() } = {}) {
  for (const f of ['model', 'task_class']) if (!c[f]) throw new Error(`admission requires ${f}`);
  if (!Number.isInteger(c.rung) || typeof c.unit_cost !== 'number') throw new Error('admission requires an integer rung and a numeric unit_cost');
  const gate = c.gate ?? 0.7;
  if (gate < GATE_RANGE[0] || gate > GATE_RANGE[1]) throw new Error(`class gate must be between ${GATE_RANGE[0]} and ${GATE_RANGE[1]}`);
  const nowIso = iso(now), need = c.need || {};
  const no = async (stage, reason, m) => { await stageRow(db, c, 'rejected', `${stage}: ${reason}`, nowIso, m); return { admitted: false, stage, reason, ...(m || {}) }; };

  const floor = await floorViolation(db, c.model);
  if (floor) return no('floor', floor);
  await stageRow(db, c, 'floor', 'pass', nowIso);

  let canary;
  try { canary = await c.canary(); } catch (e) { return no('canary', `canary could not run: ${String(e && e.message).slice(0, 120)}`); }
  const tool = bit(canary && canary.tool_calls), schema = bit(canary && canary.schema);
  await recordCanary(db, { model: c.model, task_class: c.task_class, tool_calls: tool, schema, need }, { now, updateMatrix: false });
  if (need.tool_calls && tool !== 1) return no('canary', 'no valid tool calls', { evidence: { tool_calls: tool, schema } });
  if (need.schema && schema !== 1) return no('canary', 'output does not meet the schema', { evidence: { tool_calls: tool, schema } });
  await stageRow(db, c, 'canary', 'pass', nowIso, { evidence: { tool_calls: tool, schema } });

  let agreement = null;
  if (c.decision) {
    const s = Array.isArray(c.sample) ? { n: c.sample.length, agree: c.sample.filter(x => x.answer === x.label).length } : c.sample || { n: 0, agree: 0 };
    const share = s.n ? s.agree / s.n : null, lb = wilsonLower(s.agree, s.n);
    const m = { n: s.n, agree: share, lower_bound: lb, gate };
    if (s.n < 30) return no('agreement', `inconclusive: ${s.n} labelled answers, fewer than 30`, m);
    if (lb < gate) return no('agreement', `lower bound ${lb.toFixed(2)} is under the class gate ${gate}`, m);
    await stageRow(db, c, 'agreement', 'pass', nowIso, m);
    agreement = share;
  }
  await run(db, `INSERT INTO ladder_model_task_matrix (task_class, rung, model, unit_cost, canary_tool_calls, canary_schema, ctx_tokens, max_out, agreement, admitted_at, probed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(task_class, rung, model) DO UPDATE SET unit_cost=excluded.unit_cost, canary_tool_calls=excluded.canary_tool_calls, canary_schema=excluded.canary_schema,
        ctx_tokens=excluded.ctx_tokens, max_out=excluded.max_out, agreement=excluded.agreement, admitted_at=excluded.admitted_at, probed_at=excluded.probed_at`,
    c.task_class, c.rung, c.model, c.unit_cost, tool, schema, c.ctx_tokens ?? null, c.max_out ?? null, agreement, nowIso, nowIso);
  await stageRow(db, c, 'admitted', `rung ${c.rung}`, nowIso, { gate: c.decision ? gate : null, agree: agreement, evidence: { need, decision: Boolean(c.decision) } });
  return { admitted: true, stage: 'admitted', agree: agreement };
}

/** A scheduled canary result. Updates the matrix row's canary columns and probed_at. */
export async function recordCanary(db, r, { now = Date.now(), updateMatrix = true } = {}) {
  const nowIso = iso(now), tool = bit(r.tool_calls), schema = bit(r.schema), need = r.need || {};
  const passed = (need.tool_calls ? tool === 1 : tool !== 0) && (need.schema ? schema === 1 : schema !== 0) ? 1 : 0;
  await run(db, `INSERT INTO ladder_canary_runs (model, task_class, tool_calls, schema_ok, passed, at) VALUES (?,?,?,?,?,?)`, r.model, r.task_class, tool, schema, passed, nowIso);
  if (updateMatrix) await run(db, `UPDATE ladder_model_task_matrix SET canary_tool_calls=?, canary_schema=?, probed_at=? WHERE model=? AND task_class=?`, tool, schema, nowIso, r.model, r.task_class);
  return { passed: Boolean(passed) };
}

// ---- Routing: capability first, price a tiebreaker (US-09-R08) ----

const capable = (row, need) => (!need.tool_calls || row.canary_tool_calls === 1) && (!need.schema || row.canary_schema === 1);

/** The admitted models of a class that pass the canaries the task needs, lowest rung first, cheapest first inside a rung. */
export async function candidates(db, { task_class, need = {} }) {
  const rows = await all(db, `SELECT * FROM ladder_model_task_matrix WHERE task_class = ? ORDER BY rung, unit_cost, model`, task_class);
  return rows.filter(r => capable(r, need));
}

/** Route a class to one named model. Refused when the model has no row for the class or lacks a passing canary it needs (T04). */
export async function canRoute(db, { task_class, model, need = {} }) {
  const row = await first(db, `SELECT * FROM ladder_model_task_matrix WHERE task_class = ? AND model = ? ORDER BY rung LIMIT 1`, task_class, model);
  if (!row) return { ok: false, refusal: 'not_admitted' };
  if (need.tool_calls && row.canary_tool_calls !== 1) return { ok: false, refusal: 'canary_tool_calls' };
  if (need.schema && row.canary_schema !== 1) return { ok: false, refusal: 'canary_schema' };
  return { ok: true, rung: row.rung, unit_cost: row.unit_cost };
}

async function fileItem(db, id, title, done, nowIso, priority = 10) {
  await run(db, `INSERT OR IGNORE INTO items (id, title, kind, owner_role, done_check, priority, status, created_at, updated_at) VALUES (?,?,'fix','operations',?,?,'ready',?,?)`,
    id, String(title).slice(0, 300), done, priority, nowIso, nowIso);
  return id;
}
const attempt = (db, a, nowIso) => run(db, `INSERT INTO ladder_attempts (task_id, task_class, layer, rung, model, cost, verified, signal, steered, at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  a.task_id, a.task_class, a.layer, a.rung ?? null, a.model ?? null, a.cost || 0, a.verified ? 1 : 0, a.signal ?? null, a.steered ? 1 : 0, nowIso);

/**
 * L3 cascade (US-09-R07, R09). Runs the lowest capable rung; moves up one rung only on a measured signal recorded in the
 * attempt row; at most `maxRetries` (default 2) escalations; a task that still fails is filed as a work item, not retried.
 * While `capBreached` is true only free rungs (unit_cost 0) are used when any exists, so a cap steers and never ends a task
 * that has a free path.
 *   run: async (row) => ({ output, cost? })     validate: (output) => ({ ok, signal? })
 */
export async function cascade(db, { task_id, task_class, need = {}, run: runModel, validate, maxRetries = 2, capBreached = false }, { now = Date.now() } = {}) {
  const nowIso = iso(now);
  let rows = await candidates(db, { task_class, need });
  if (!rows.length) return { ok: false, refusal: 'no_capable_model', attempts: 0 };
  let steered = false;
  if (capBreached) {
    const free = rows.filter(r => r.unit_cost === 0);
    if (free.length) { rows = free; steered = true; }
    else return { ok: false, refusal: 'cap_breached_no_free_rung', queued: true, attempts: 0 }; // degradation order: queue for the next window
  }
  const rungs = [...new Set(rows.map(r => r.rung))];
  let attempts = 0, last = null;
  for (let i = 0; i < rungs.length && attempts <= maxRetries; i++) {
    const row = rows.find(r => r.rung === rungs[i]);
    attempts++;
    let out = null, v;
    try { out = await runModel(row); v = validate(out.output); }
    catch (e) { v = { ok: false, signal: 'provider_error', detail: String(e && e.message).slice(0, 120) }; }
    const cost = (out && typeof out.cost === 'number') ? out.cost : row.unit_cost;
    const signal = v.ok ? null : v.signal;
    await attempt(db, { task_id, task_class, layer: 'cascade', rung: row.rung, model: row.model, cost, verified: v.ok, signal, steered }, nowIso);
    if (v.ok) return { ok: true, output: out.output, model: row.model, rung: row.rung, attempts, steered };
    last = { model: row.model, rung: row.rung, signal };
    if (!ESCALATION_SIGNALS.includes(signal)) break; // no measured signal: no escalation
  }
  const item = await fileItem(db, `TASKFAIL-${task_id}`, `Task ${task_id} (${task_class}) failed after ${attempts} attempt(s); last: ${last.model} ${last.signal || 'no measured signal'}`,
    `task ${task_id} produces an output that passes validation`, nowIso);
  return { ok: false, refusal: 'failed', item, attempts, last, steered };
}

/**
 * L6 draft then verify. A cheap model drafts; deterministic checks run on the draft; the frontier model is called to repair
 * only when a check fails, once, and the checks run again. A repair that still fails is filed as a work item.
 *   draft: async () => ({ output, cost, model })   repair: async (output, failedChecks) => ({ output, cost, model })
 *   checks: [{ name, check: (output) => boolean }]
 */
export async function draftThenVerify(db, { task_id, task_class, draft, repair, checks }, { now = Date.now() } = {}) {
  if (!Array.isArray(checks) || !checks.length) throw new Error('draft-then-verify needs at least one deterministic check');
  const nowIso = iso(now);
  const failing = (output) => checks.filter(c => { try { return !c.check(output); } catch { return true; } }).map(c => c.name);
  let d;
  try { d = await draft(); } catch (e) { d = { output: null, cost: 0, model: null, error: String(e && e.message).slice(0, 120) }; }
  let failed = d.error ? ['draft_error'] : failing(d.output);
  await attempt(db, { task_id, task_class, layer: 'draft', model: d.model, cost: d.cost, verified: !failed.length, signal: failed.length ? `check:${failed.join(',')}` : null }, nowIso);
  if (!failed.length) return { ok: true, output: d.output, repaired: false, model: d.model, cost: d.cost || 0 };
  let r;
  try { r = await repair(d.output, failed); } catch (e) { r = { output: null, cost: 0, model: null, error: String(e && e.message).slice(0, 120) }; }
  const still = r.error ? ['repair_error'] : failing(r.output);
  await attempt(db, { task_id, task_class, layer: 'repair', model: r.model, cost: r.cost, verified: !still.length, signal: still.length ? `check:${still.join(',')}` : null }, nowIso);
  const cost = (d.cost || 0) + (r.cost || 0);
  if (!still.length) return { ok: true, output: r.output, repaired: true, failed_checks: failed, model: r.model, cost };
  const item = await fileItem(db, `TASKFAIL-${task_id}`, `Task ${task_id} (${task_class}) fails checks after repair: ${still.join(', ')}`, `task ${task_id} passes: ${checks.map(c => c.name).join(', ')}`, nowIso);
  return { ok: false, repaired: true, failed_checks: still, item, cost };
}

/** Cost per verified outcome, escalation rate and attempts per task class. */
export async function costPerTask(db, taskClass = null) {
  return taskClass === null ? all(db, `SELECT * FROM ladder_v_cost_per_task ORDER BY task_class`) : first(db, `SELECT * FROM ladder_v_cost_per_task WHERE task_class = ?`, taskClass);
}

// ---- Monitoring: shadow sample and demotion (steps 2318 to 2322) ----

/** Deterministic shadow selection: the same decision key is always in or always out; about `rate` of keys are in. */
export function shouldShadow(key, rate = 0.05) {
  let h = 0x811c9dc5;
  for (const ch of String(key)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h % 10000) / 10000 < rate;
}

export async function recordShadow(db, s, { now = Date.now() } = {}) {
  const agree = s.model_answer === s.label ? 1 : 0;
  await run(db, `INSERT INTO ladder_shadow_samples (model, task_class, decision_ref, model_answer, label, agree, at) VALUES (?,?,?,?,?,?,?)`,
    s.model, s.task_class, s.decision_ref ?? null, String(s.model_answer), String(s.label), agree, iso(now));
  return { agree: Boolean(agree) };
}

export async function rollingAgreement(db, { model, task_class, window = 200 }) {
  const r = await first(db, `SELECT COUNT(*) AS n, COALESCE(SUM(agree), 0) AS agree FROM (SELECT agree FROM ladder_shadow_samples WHERE model = ? AND task_class = ? ORDER BY id DESC LIMIT ?)`, model, task_class, window);
  return { n: r.n, agreement: r.n ? r.agree / r.n : null };
}

/**
 * The demotion step. A matrix row is removed, with a `demoted` admission row and a work item, when: the model is now below
 * the floor; its canary failed on the last two runs; or its rolling agreement on the shadow sample (at least `min_n` samples)
 * fell below its class gate minus `margin` (default 0.05).
 */
export async function monitor(db, { now = Date.now(), margin = 0.05, window = 200, min_n = 30 } = {}) {
  const nowIso = iso(now), out = [];
  for (const row of await all(db, `SELECT * FROM ladder_model_task_matrix ORDER BY task_class, rung, model`)) {
    let reason = await floorViolation(db, row.model), evidence = null;
    if (reason) reason = `floor: ${reason}`;
    if (!reason) {
      const runs = await all(db, `SELECT passed FROM ladder_canary_runs WHERE model = ? AND task_class = ? ORDER BY id DESC LIMIT 2`, row.model, row.task_class);
      if (runs.length === 2 && runs.every(r => r.passed === 0)) reason = 'canary failed twice';
    }
    if (!reason) {
      const adm = await first(db, `SELECT gate FROM ladder_model_admission WHERE model = ? AND task_class = ? AND stage = 'admitted' ORDER BY id DESC LIMIT 1`, row.model, row.task_class);
      if (adm && adm.gate !== null) {
        const roll = await rollingAgreement(db, { model: row.model, task_class: row.task_class, window });
        if (roll.n >= min_n && roll.agreement < adm.gate - margin) { reason = `rolling agreement ${roll.agreement.toFixed(2)} over ${roll.n} is under gate ${adm.gate} minus ${margin}`; evidence = { ...roll, gate: adm.gate, margin }; }
      }
    }
    if (!reason) continue;
    await run(db, `DELETE FROM ladder_model_task_matrix WHERE task_class = ? AND rung = ? AND model = ?`, row.task_class, row.rung, row.model);
    await stageRow(db, row, 'demoted', reason, nowIso, { n: evidence?.n, agree: evidence?.agreement, gate: evidence?.gate, evidence: { rung: row.rung, ...(evidence || {}) } });
    const left = (await first(db, `SELECT COUNT(*) AS n FROM ladder_model_task_matrix WHERE task_class = ?`, row.task_class)).n;
    const item = await fileItem(db, `MODEL-DEMOTED-${row.task_class}-${row.model}-${nowIso.slice(0, 10)}`.replace(/[^A-Za-z0-9_.:-]/g, '_'),
      `Model ${row.model} removed from ${row.task_class} rung ${row.rung}: ${reason}${left ? '' : '; the class has no admitted model left'}`,
      `class ${row.task_class} has an admitted model that passes its canary and gate`, nowIso, left ? 20 : 0);
    out.push({ model: row.model, task_class: row.task_class, rung: row.rung, reason, item });
  }
  return out;
}

/** One guarded pass for a tick: the demotion step. Scheduled canaries and shadow answers are recorded by their callers. */
export async function step({ db, now = Date.now(), config = {} } = {}) {
  const demoted = await monitor(db, { now, ...config });
  return { demoted: demoted.length, items: demoted.map(d => d.item) };
}
