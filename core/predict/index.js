// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Predict, act, verify, score (US-SPEC-05). Decision log with parsed predictions, scorer, calibration (aggregate and binned),
// health numbers with triggers, and the realization gate that enforces assertion states by program.
// Ports: db (D1-style), now (ms), metrics ({ name: async (db, nowMs, row) => number }), config. No ambient state.

export const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);
export const OPS = ['<', '<=', '>', '>=', '=', 'between', 'closed'];
export const ASSERTION_STATES = ['code-only', 'staged', 'inferred', 'observed'];
const TERMINAL = ['done', 'superseded', 'cancelled'];

const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();

const NUM = '(-?\\d+(?:\\.\\d+)?)';
const NAME = '([A-Za-z0-9_.:-]+)';
const RE_SIMPLE = new RegExp(`^\\s*${NAME}\\s*(>=|<=|>|<|=)\\s*${NUM}\\s+within\\s+(\\d+(?:\\.\\d+)?)\\s*h\\s*$`);
const RE_BETWEEN = new RegExp(`^\\s*${NAME}\\s+between\\s+${NUM}\\s+and\\s+${NUM}\\s+within\\s+(\\d+(?:\\.\\d+)?)\\s*h\\s*$`);
const RE_ISSUE = new RegExp(`^\\s*issue\\s+${NAME}\\s+closed\\s+within\\s+(\\d+(?:\\.\\d+)?)\\s*h\\s*$`);

/** US-05-R07: the three accepted forms of section 3.1. Returns null when the text is not parsable. */
export function parsePrediction(text) {
  const s = String(text ?? '');
  let m;
  if ((m = RE_SIMPLE.exec(s))) return { form: 'metric', subject: m[1], op: m[2], value: Number(m[3]), value2: null, hours: Number(m[4]) };
  if ((m = RE_BETWEEN.exec(s))) return { form: 'metric', subject: m[1], op: 'between', value: Number(m[2]), value2: Number(m[3]), hours: Number(m[4]) };
  if ((m = RE_ISSUE.exec(s))) return { form: 'issue', subject: m[1], op: 'closed', value: null, value2: null, hours: Number(m[2]) };
  return null;
}

/** A decision text may carry its prediction on any line or after a "Prediction:" label; the first parsable one wins. */
export function findPrediction(text) {
  for (const line of String(text ?? '').split(/\n|;\s+/)) {
    const p = parsePrediction(line.replace(/^\s*prediction\s*:\s*/i, '').replace(/[.\s]+$/, ''));
    if (p) return p;
  }
  return null;
}

function assertReadOnly(sql) {
  const s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!/^select\b/i.test(s) || s.includes(';')) throw new Error('must be a single SELECT');
  if (/\b(insert|update|delete|drop|alter|create|replace|pragma|attach|detach|vacuum)\b/i.test(s)) throw new Error('must be read-only');
  return s;
}

function checkConfidence(c) {
  if (c === undefined || c === null) return null;
  if (typeof c !== 'number' || !(c >= 0 && c <= 1)) throw new Error('confidence must be a number in [0, 1]');
  return c;
}

// US-05-R01: a prediction row names a subject, an operator, a target and a due time, or it is not stored.
async function insertPrediction(db, p) {
  if (!p.id) throw new Error('prediction requires id');
  if (!['metric', 'issue'].includes(p.form)) throw new Error('prediction form must be metric or issue');
  if (!p.subject || !String(p.subject).trim()) throw new Error('prediction requires a metric or issue');
  if (!OPS.includes(p.op)) throw new Error(`prediction operator must be one of ${OPS.join(' ')}`);
  if (p.form === 'issue' && p.op !== 'closed') throw new Error('an issue prediction uses the operator closed');
  if (p.form === 'metric') {
    if (p.op === 'closed') throw new Error('closed applies to an issue');
    if (typeof p.value !== 'number' || !Number.isFinite(p.value)) throw new Error('prediction requires a numeric target');
    if (p.op === 'between' && (typeof p.value2 !== 'number' || !Number.isFinite(p.value2) || p.value2 < p.value)) throw new Error('between requires a <= b');
  }
  if (!p.due_at || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(p.due_at)) throw new Error('prediction requires a due time');
  await run(db, `INSERT INTO predict_predictions (id, decision_id, origin, form, subject, op, value, value2, due_at, confidence, decision_type, persona, action_class, surface)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    p.id, p.decision_id ?? null, p.origin || 'parsed', p.form, p.subject, p.op, p.value ?? null, p.value2 ?? null, p.due_at,
    checkConfidence(p.confidence), p.decision_type ?? null, p.persona ?? null, p.action_class ?? null, p.surface ?? null);
}

/**
 * US-05-R06: the decision is stored with its predicted outcome and revert path before it executes. A parsable predicted
 * outcome is copied to the prediction table with due_at = decision time + N hours (US-05-R07, T03). `execute`, when given,
 * runs only after both rows exist.
 */
export async function recordDecision(db, d, { now = Date.now(), execute } = {}) {
  for (const f of ['id', 'decision', 'predicted_outcome', 'revert_path']) {
    if (!d[f] || !String(d[f]).trim()) throw new Error(`decision requires ${f}`);
  }
  const p = findPrediction(d.predicted_outcome);
  const conf = checkConfidence(d.confidence);
  await run(db, `INSERT INTO predict_decisions (id, decided_at, actor, persona, action_class, surface, decision_type, decision, reason, predicted_outcome, revert_path, confidence, parsable, item_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    d.id, iso(now), d.actor ?? null, d.persona ?? null, d.action_class ?? null, d.surface ?? null, d.decision_type ?? d.action_class ?? null,
    d.decision, d.reason ?? null, d.predicted_outcome, d.revert_path, conf, p ? 1 : 0, d.item_id ?? null);
  if (p) {
    await insertPrediction(db, { ...p, id: `P-${d.id}`, decision_id: d.id, origin: 'parsed', due_at: iso(now + p.hours * 3600e3), confidence: conf,
      decision_type: d.decision_type ?? d.action_class ?? null, persona: d.persona, action_class: d.action_class, surface: d.surface });
  }
  const out = { id: d.id, parsable: Boolean(p), prediction_id: p ? `P-${d.id}` : null };
  if (execute) out.result = await execute(out);
  return out;
}

/** Predictions seeded in structured form (origin `seeded`). */
export async function seedPrediction(db, p, { now = Date.now() } = {}) {
  const due = p.due_at ?? (typeof p.hours === 'number' ? iso(now + p.hours * 3600e3) : null);
  await insertPrediction(db, { ...p, form: p.form || (p.op === 'closed' ? 'issue' : 'metric'), origin: 'seeded', due_at: due });
  return { id: p.id, due_at: due };
}

export async function registerMetric(db, { name, read_sql, description }) {
  if (!name) throw new Error('metric name required');
  await run(db, `INSERT INTO predict_metrics (name, read_sql, description) VALUES (?,?,?)
      ON CONFLICT(name) DO UPDATE SET read_sql=excluded.read_sql, description=excluded.description`, name, assertReadOnly(read_sql), description ?? null);
}

const CMP = { '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b, '=': (a, b) => a === b };

async function readSubject(db, p, now, metrics) {
  if (p.form === 'issue') {
    const it = await first(db, `SELECT status FROM items WHERE id = ?`, p.subject);
    return { observed: it && it.status === 'done' ? 1 : 0, known: true };
  }
  const own = Object.prototype.hasOwnProperty.call(metrics, p.subject);
  const reg = own ? null : await first(db, `SELECT read_sql FROM predict_metrics WHERE name = ?`, p.subject);
  if (!own && !reg) return { known: false, reason: 'unknown metric' };
  try {
    let v;
    if (own) v = await metrics[p.subject](db, now, p);
    else { const row = await first(db, assertReadOnly(reg.read_sql)); v = row ? Object.values(row)[0] : null; }
    if (v === null || v === undefined || typeof v === 'boolean' || !Number.isFinite(Number(v))) return { known: true, observed: null, reason: 'metric returned no finite number' };
    return { known: true, observed: Number(v) };
  } catch (e) { return { known: true, observed: null, reason: `metric failed: ${String(e && e.message).slice(0, 120)}` }; }
}

/**
 * US-05-R02, R03: every prediction with no verdict whose due time has passed is evaluated; the observed value and verdict
 * are stored and an outcome row is written. An unknown metric or operator, or a metric that cannot be read, scores as a miss
 * with observed null. A scored prediction with a surface and action class also writes one seed `outcomes` row, which is how
 * scoring feeds the trust ledger (section 3, step 514).
 */
export async function scoreDue(db, { now = Date.now(), metrics = {}, limit = 500 } = {}) {
  const nowIso = iso(now);
  const due = await all(db, `SELECT * FROM predict_predictions WHERE matched IS NULL AND due_at <= ? ORDER BY due_at, id LIMIT ?`, nowIso, limit);
  const out = [];
  for (const p of due) {
    let observed = null, matched = 0, reason = null;
    if (!OPS.includes(p.op) || (p.form === 'metric' && p.op === 'closed')) reason = 'unknown operator';
    else {
      const r = await readSubject(db, p, now, metrics);
      observed = r.observed ?? null; reason = r.reason ?? null;
      if (r.known && observed !== null) {
        matched = p.op === 'closed' ? (observed === 1 ? 1 : 0)
          : p.op === 'between' ? (observed >= p.value && observed <= p.value2 ? 1 : 0)
          : (CMP[p.op](observed, p.value) ? 1 : 0);
      }
    }
    await run(db, `UPDATE predict_predictions SET observed=?, matched=?, scored_at=?, note=? WHERE id=? AND matched IS NULL`, observed, matched, nowIso, reason, p.id);
    await run(db, `INSERT INTO predict_outcomes (prediction_id, decision_id, observed, matched, reason, scored_at) VALUES (?,?,?,?,?,?)`,
      p.id, p.decision_id ?? null, observed, matched, reason, nowIso);
    if (p.surface && p.action_class) {
      await run(db, `INSERT INTO outcomes (item_id, agent, surface, action_class, result, evidence, at) VALUES (?,?,?,?,?,?,?)`,
        null, p.persona ?? null, p.surface, p.action_class, matched ? 'verified' : 'failed',
        `prediction ${p.id}: ${p.subject} ${p.op} ${p.value ?? ''} observed ${observed === null ? 'null' : observed}`.slice(0, 300), nowIso);
    }
    out.push({ id: p.id, observed, matched, verdict: matched ? 'hit' : 'miss', reason });
  }
  return out;
}

/** Matched share by persona, action class and surface (section 3.2). */
export async function calibrationViews(db) {
  return {
    by_persona: await all(db, `SELECT * FROM predict_v_calibration_persona ORDER BY persona`),
    by_action_class: await all(db, `SELECT * FROM predict_v_calibration_action_class ORDER BY action_class`),
    by_surface: await all(db, `SELECT * FROM predict_v_calibration_surface ORDER BY surface`),
  };
}

const BIN_LABEL = (b) => `${(0.5 + b / 10).toFixed(1)}-${(0.6 + b / 10).toFixed(1)}`;

/**
 * US-05-R13: per decision type, predictions with stated confidence p are grouped in bins 0.5-0.6 .. 0.9-1.0. Returns the hit
 * rate per bin, the calibration error (count-weighted mean of |p_bin - h_bin|) and the Brier score (mean of (p - outcome)^2).
 */
export async function binnedCalibration(db, { decision_type = null } = {}) {
  const rows = decision_type === null
    ? await all(db, `SELECT * FROM predict_v_calibration_bins ORDER BY decision_type, bin`)
    : await all(db, `SELECT * FROM predict_v_calibration_bins WHERE decision_type = ? ORDER BY bin`, decision_type);
  const byType = new Map();
  for (const r of rows) {
    if (!byType.has(r.decision_type)) byType.set(r.decision_type, []);
    byType.get(r.decision_type).push(r);
  }
  const out = [];
  for (const [type, bins] of byType) {
    const n = bins.reduce((s, b) => s + b.n, 0);
    out.push({
      decision_type: type, n,
      bins: bins.map(b => ({ bin: b.bin, range: BIN_LABEL(b.bin), n: b.n, mean_p: b.mean_p, hit_rate: b.hit_rate, gap: b.mean_p - b.hit_rate })),
      calibration_error: bins.reduce((s, b) => s + b.n * Math.abs(b.mean_p - b.hit_rate), 0) / n,
      brier: bins.reduce((s, b) => s + b.sq_err, 0) / n,
    });
  }
  return out;
}

/** Recompute the stored correction per (decision type, bin). A bin with fewer than `min_n` scored predictions corrects nothing. */
export async function calibrate(db, { now = Date.now(), min_n = 20 } = {}) {
  const nowIso = iso(now);
  const types = await binnedCalibration(db);
  for (const t of types) for (const b of t.bins) {
    const correction = b.n >= min_n && b.gap > 0 ? b.gap : 0;
    await run(db, `INSERT INTO predict_confidence_caps (decision_type, bin, n, mean_p, hit_rate, correction, computed_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(decision_type, bin) DO UPDATE SET n=excluded.n, mean_p=excluded.mean_p, hit_rate=excluded.hit_rate, correction=excluded.correction, computed_at=excluded.computed_at`,
      t.decision_type, b.bin, b.n, b.mean_p, b.hit_rate, correction, nowIso);
  }
  return types;
}

const binOf = (p) => Math.min(4, Math.floor((p - 0.5) * 10 + 1e-6));

/**
 * US-05-R13: stated confidence that gates autonomous action is corrected by the measured overconfidence of its bin.
 * Returns { stated, corrected, correction, allowed }: allowed is true only when the corrected value meets the threshold.
 * A stated confidence below 0.5 is outside the bins and never clears a gate.
 */
export async function gateConfidence(db, { decision_type, confidence, threshold }) {
  const stated = checkConfidence(confidence);
  if (stated === null) throw new Error('confidence required');
  if (stated < 0.5) return { stated, corrected: stated, correction: 0, allowed: false };
  const row = await first(db, `SELECT correction FROM predict_confidence_caps WHERE decision_type = ? AND bin = ?`, decision_type ?? '', binOf(stated));
  const correction = row ? row.correction : 0;
  const corrected = Math.max(0, stated - correction);
  return { stated, corrected, correction, allowed: corrected >= threshold };
}

export const HEALTH_DEFAULTS = { min_parsable_share_7d: 0.8, max_miss_rate_7d: 0.5, max_unscored_overdue: 0, owner_role: 'operations' };

/** US-05-R08: share of decisions with a parsable prediction in 7 days, miss rate in 7 days, predictions unscored beyond their deadline. */
export async function health(db, { now = Date.now() } = {}) {
  const since = iso(now - 7 * 86400e3), nowIso = iso(now);
  const d = await first(db, `SELECT COUNT(*) AS n, COALESCE(SUM(parsable), 0) AS p FROM predict_decisions WHERE decided_at >= ?`, since);
  const s = await first(db, `SELECT COUNT(*) AS n, COALESCE(SUM(1 - matched), 0) AS miss FROM predict_predictions WHERE matched IS NOT NULL AND scored_at >= ?`, since);
  const o = await first(db, `SELECT COUNT(*) AS n FROM predict_predictions WHERE matched IS NULL AND due_at <= ?`, nowIso);
  return {
    parsable_share_7d: d.n ? d.p / d.n : null,
    miss_rate_7d: s.n ? s.miss / s.n : null,
    unscored_overdue: o.n,
    decisions_7d: d.n, scored_7d: s.n,
  };
}

async function ensureItem(db, it, nowIso) {
  if (await first(db, `SELECT 1 AS x FROM items WHERE id = ?`, it.id)) return false;
  await run(db, `INSERT INTO items (id, title, kind, owner_role, done_check, closing_probe, priority, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?, 'ready', ?, ?)`,
    it.id, String(it.title).slice(0, 300), it.kind || 'fix', it.owner_role, it.done_check, it.closing_probe ?? null, it.priority ?? 10, nowIso, nowIso);
  return true;
}

/** The trigger on each health number: a breach files one work item per number and day; an unmeasured number files nothing. */
export async function checkHealth(db, { now = Date.now(), config = {} } = {}) {
  const c = { ...HEALTH_DEFAULTS, ...config };
  const h = await health(db, { now });
  const nowIso = iso(now), day = nowIso.slice(0, 10);
  const breaches = [];
  if (h.parsable_share_7d !== null && h.parsable_share_7d < c.min_parsable_share_7d) breaches.push(['parsable-share', `Parsable prediction share ${(h.parsable_share_7d * 100).toFixed(0)}% over 7 days is under ${(c.min_parsable_share_7d * 100).toFixed(0)}%`, `parsable_share_7d >= ${c.min_parsable_share_7d}`]);
  if (h.miss_rate_7d !== null && h.miss_rate_7d > c.max_miss_rate_7d) breaches.push(['miss-rate', `Prediction miss rate ${(h.miss_rate_7d * 100).toFixed(0)}% over 7 days is over ${(c.max_miss_rate_7d * 100).toFixed(0)}%`, `miss_rate_7d <= ${c.max_miss_rate_7d}`]);
  if (h.unscored_overdue > c.max_unscored_overdue) breaches.push(['unscored-overdue', `${h.unscored_overdue} prediction(s) unscored beyond their deadline`, `unscored_overdue <= ${c.max_unscored_overdue}`]);
  const filed = [];
  for (const [key, title, check] of breaches) {
    const id = `PREDICT-${key}-${day}`;
    if (await ensureItem(db, { id, title, owner_role: c.owner_role, done_check: check, priority: 5 }, nowIso)) filed.push(id);
  }
  return { ...h, breaches: breaches.map(b => b[0]), filed };
}

// ---- Realization gate (section 3.3) ----

function passes(value, condition) {
  const m = /^\s*(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(condition ?? '');
  if (!m || value === null || !Number.isFinite(value)) return null;
  return CMP[m[1]](value, Number(m[2]));
}

/**
 * Record an assertion about a fix. The caller may assert `code-only`, `staged` or `inferred`. `observed` cannot be asserted:
 * it is reached only through observe(), which runs the deciding query and checks the pass condition (US-05-R04, R10).
 * An `inferred` assertion must carry a re-test date (US-05-R11).
 */
export async function recordAssertion(db, a, { now = Date.now() } = {}) {
  if (!a.finding_id) throw new Error('assertion requires finding_id');
  if (!ASSERTION_STATES.includes(a.state)) throw new Error(`assertion state must be one of ${ASSERTION_STATES.join(', ')}`);
  if (a.state === 'observed') throw new Error('observed is set only by observe(), which runs the deciding query');
  for (const f of ['deciding_query', 'pass_condition', 'fail_condition', 'null_expectation']) {
    if (!a[f] || !String(a[f]).trim()) throw new Error(`assertion requires ${f}`);
  }
  if (a.state === 'inferred' && !/^\d{4}-\d\d-\d\d/.test(a.retest_at || '')) throw new Error('an inferred assertion requires a re-test date');
  const r = await run(db, `INSERT INTO predict_assertions (finding_id, state, deciding_query, pass_condition, fail_condition, null_expectation, evidence, produced_by, verified_by, independent, retest_at, recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    a.finding_id, a.state, a.deciding_query, a.pass_condition, a.fail_condition, a.null_expectation, a.evidence ?? null,
    a.produced_by ?? null, a.verified_by ?? null, a.verified_by && a.produced_by ? (a.verified_by !== a.produced_by ? 1 : 0) : null,
    a.retest_at ?? null, iso(now));
  return { id: r.meta.last_row_id, state: a.state };
}

export async function latestAssertion(db, findingId) {
  return first(db, `SELECT * FROM predict_assertions WHERE finding_id = ? ORDER BY id DESC LIMIT 1`, findingId);
}

/**
 * Run the deciding query of the finding's latest assertion against the territory. `read` is the port to the running system:
 * async (query) => number. Without it the query must be one read-only SELECT and is run on `db`. A passing read writes an
 * `observed` assertion with the value read; anything else leaves the state as it was. `verified_by` names the verifying path;
 * with `require_independent` a verifier equal to the producer is refused (US-05-R12).
 */
export async function observe(db, findingId, { now = Date.now(), read, verified_by = null, require_independent = false } = {}) {
  const a = await latestAssertion(db, findingId);
  if (!a) throw new Error(`no assertion recorded for ${findingId}`);
  const independent = verified_by && a.produced_by ? (verified_by !== a.produced_by ? 1 : 0) : null;
  if (require_independent && independent !== 1) return { finding_id: findingId, state: a.state, observed: false, reason: 'verification path is not independent of the producing path' };
  let value = null, reason = null;
  try {
    if (read) value = await read(a.deciding_query);
    else { const row = await first(db, assertReadOnly(a.deciding_query)); value = row ? Object.values(row)[0] : null; }
    value = value === null || value === undefined || typeof value === 'boolean' || !Number.isFinite(Number(value)) ? null : Number(value);
  } catch (e) { reason = `deciding query failed: ${String(e && e.message).slice(0, 120)}`; }
  const ok = passes(value, a.pass_condition);
  if (ok !== true) {
    return { finding_id: findingId, state: a.state, observed: false, value, reason: reason || (ok === null ? 'deciding query returned no number, or the pass condition is not of the form "<op> <number>"' : `value ${value} does not meet ${a.pass_condition}`) };
  }
  const r = await run(db, `INSERT INTO predict_assertions (finding_id, state, deciding_query, pass_condition, fail_condition, null_expectation, query_value, evidence, produced_by, verified_by, independent, recorded_at)
      VALUES (?, 'observed', ?,?,?,?,?,?,?,?,?,?)`,
    findingId, a.deciding_query, a.pass_condition, a.fail_condition, a.null_expectation, value,
    `deciding query read ${value}; pass condition ${a.pass_condition}`, a.produced_by, verified_by, independent, iso(now));
  return { finding_id: findingId, state: 'observed', observed: true, value, independent, assertion_id: r.meta.last_row_id };
}

/**
 * Close a finding through the gate. `observed` closes it. `inferred` closes it with the label `inferred` and its re-test date
 * (US-05-R11). `code-only`, `staged` or no assertion leave it open and mark it pending (US-05-R04, R05, R10): a merge alone,
 * or a done check never observed, closes nothing.
 */
export async function closeFinding(db, findingId, { now = Date.now() } = {}) {
  const item = await first(db, `SELECT id, status FROM items WHERE id = ?`, findingId);
  if (!item) throw new Error(`unknown finding ${findingId}`);
  const a = await latestAssertion(db, findingId);
  const nowIso = iso(now);
  if (!a || a.state === 'code-only' || a.state === 'staged') {
    const state = a ? a.state : 'none';
    if (!TERMINAL.includes(item.status)) {
      await run(db, `UPDATE items SET blocker=?, updated_at=? WHERE id=?`, `pending: assertion state ${state}; closes only when the deciding query observes the change`, nowIso, findingId);
    }
    return { finding_id: findingId, closed: false, status: 'pending', state };
  }
  const disposition = a.state === 'observed'
    ? `done: observed (assertion ${a.id}): ${a.evidence || ''}`.slice(0, 300)
    : `done: inferred (assertion ${a.id}); re-test ${a.retest_at}`;
  await run(db, `UPDATE items SET status='done', blocker=NULL, disposition=?, updated_at=? WHERE id=?`, disposition, nowIso, findingId);
  return { finding_id: findingId, closed: true, status: 'done', state: a.state, label: a.state === 'inferred' ? 'inferred' : null, retest_at: a.retest_at ?? null };
}

/**
 * The scheduled re-test of `inferred` closures whose date has come. A passing deciding query upgrades the finding to
 * `observed`; a failing one reopens the finding with the reason. `read` as in observe().
 */
export async function retestDue(db, { now = Date.now(), read } = {}) {
  const nowIso = iso(now);
  const due = await all(db, `SELECT a.* FROM predict_assertions a
      WHERE a.state = 'inferred' AND a.retested_at IS NULL AND a.retest_at <= ?
        AND a.id = (SELECT MAX(id) FROM predict_assertions WHERE finding_id = a.finding_id) ORDER BY a.id`, nowIso);
  const out = [];
  for (const a of due) {
    await run(db, `UPDATE predict_assertions SET retested_at=? WHERE id=?`, nowIso, a.id);
    const r = await observe(db, a.finding_id, { now, read, verified_by: 'retest' });
    if (r.observed) {
      await run(db, `UPDATE items SET disposition=?, updated_at=? WHERE id=? AND status='done'`, `done: observed on re-test (assertion ${r.assertion_id}): read ${r.value}`, nowIso, a.finding_id);
      out.push({ finding_id: a.finding_id, result: 'observed', value: r.value });
    } else {
      await run(db, `UPDATE items SET status='ready', disposition=NULL, blocker=?, updated_at=? WHERE id=? AND status='done'`, `reopened by re-test: ${r.reason}`.slice(0, 300), nowIso, a.finding_id);
      await run(db, `INSERT INTO predict_assertions (finding_id, state, deciding_query, pass_condition, fail_condition, null_expectation, query_value, evidence, produced_by, recorded_at)
          VALUES (?, 'staged', ?,?,?,?,?,?,?,?)`, a.finding_id, a.deciding_query, a.pass_condition, a.fail_condition, a.null_expectation, r.value ?? null,
        `re-test did not observe the change: ${r.reason}`.slice(0, 300), a.produced_by, nowIso);
      out.push({ finding_id: a.finding_id, result: 'reopened', reason: r.reason });
    }
  }
  return out;
}

/** One guarded pass for a tick: score, re-test, recompute calibration, check the health triggers. */
export async function step({ db, now = Date.now(), metrics = {}, read, config = {} } = {}) {
  const scored = await scoreDue(db, { now, metrics });
  const retested = await retestDue(db, { now, read });
  await calibrate(db, { now, min_n: config.calibration_min_n });
  const h = await checkHealth(db, { now, config: config.health });
  return { scored: scored.length, hits: scored.filter(s => s.matched).length, retested: retested.length, health: h };
}
