// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Signal pipeline (US-SPEC-12 Part A): intake, triage, boundary, synthesis, ignorance audit, strict-shrink refinement,
// fitness threshold, deposit and re-entry. A general pattern for any signal source; publication is not part of it.
// Ports only: ctx = { db, now(), config, scorers?: [fn(signal) -> 0..1, fn], fitness?(signal) -> {expected_reduction, effort},
//                     synthesize?(signals) -> {title, abstract, content, assertions}, auditor?(artifact, question) -> bool }.

export const AUDIT_QUESTIONS = [
  'What is claimed?', 'What evidence supports each claim?', 'What would falsify the claim?', 'Which assumptions are unstated?',
  'What was measured, and how?', 'What is the uncertainty of each number?', 'Which alternatives were considered?', 'What is out of scope?',
  'Who or what is the source of each input?', 'Can the result be reproduced from what is given?', 'What changed since the previous version?',
  'Which prior results does this contradict?', 'What are the known limits?', 'What follows if the claim is true?', 'What is still unknown?',
];
const DEFAULTS = {
  accept_at: 0.6, log_at: 0.3, disagreement: 0.4, domains: [], audit_questions: AUDIT_QUESTIONS,
  min_experiment_n: 30, triage_batch: 50, reentry_states: ['published', 'distributed'],
};
export const cfg = ctx => ({ ...DEFAULTS, ...(ctx.config || {}) });
function nowMs(ctx) {
  const v = ctx.now();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') return Date.parse(v.includes('T') ? v : v.replace(' ', 'T') + 'Z');
  return v;
}
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
const isWeight = w => typeof w === 'number' && Number.isFinite(w) && w >= 0 && w <= 1;
const norm = s => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
const list = s => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : null; } catch { return null; } };
async function incident(ctx, kind, o = {}) {
  await run(ctx.db, `INSERT INTO signals_incidents (at, kind, worker, source, domain, ref, detail) VALUES (?,?,?,?,?,?,?)`,
    iso(nowMs(ctx)), kind, o.worker ?? null, o.source ?? null, o.domain ?? null, o.ref ?? null, o.detail ? String(o.detail).slice(0, 500) : null);
}

// ---- L0 intake (US-12-R01) ---------------------------------------------------------------------

/** A signal is (time, source, content, weight). A record without a weight is stored as noise and never triaged. */
export async function intake(ctx, s = {}) {
  if (!s.source || s.content == null || s.content === '') throw new Error('a signal needs a source and content');
  const at = iso(nowMs(ctx));
  const weight = s.weight ?? s.evidential_weight ?? null;
  const noise = !isWeight(weight);
  const id = s.id || `sig-${at.replace(/[- :]/g, '')}-${(await first(ctx.db, `SELECT COUNT(*) AS n FROM signals_signals`)).n + 1}`;
  await run(ctx.db, `INSERT INTO signals_signals (id, ts, source, source_ref, content, open_questions, evidential_weight, domain, status, decision, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id, s.ts || at, String(s.source), s.source_ref ?? null, String(s.content).slice(0, 8000), s.open_questions ? JSON.stringify(s.open_questions) : null,
    noise ? null : weight, s.domain ?? null, noise ? 'noise' : 'proposed', noise ? 'IGNORE' : null, at);
  return { id, status: noise ? 'noise' : 'proposed', noise };
}

// ---- L6 fitness threshold (US-12-R08) ----------------------------------------------------------

export async function fitnessThreshold(ctx) { return (await first(ctx.db, `SELECT threshold FROM signals_fitness WHERE id = 1`)).threshold; }
/**
 * A numeric threshold is written only when an experiment shows fitness-scored triage beat recency-scored triage.
 * Every experiment is recorded, adopted or not.
 */
export async function proposeFitnessThreshold(ctx, { threshold, n, fitness_yield, recency_yield } = {}) {
  const c = cfg(ctx), at = iso(nowMs(ctx));
  let reason = 'fitness_beat_recency';
  if (![threshold, n, fitness_yield, recency_yield].every(v => typeof v === 'number' && Number.isFinite(v))) throw new Error('an experiment reports threshold, n, fitness_yield and recency_yield as numbers');
  if (threshold <= 0) reason = 'threshold_not_positive';
  else if (n < c.min_experiment_n) reason = 'sample_too_small';
  else if (!(fitness_yield > recency_yield)) reason = 'fitness_did_not_beat_recency';
  const adopted = reason === 'fitness_beat_recency';
  const ins = await run(ctx.db, `INSERT INTO signals_experiments (at, n, fitness_yield, recency_yield, proposed_threshold, adopted, reason) VALUES (?,?,?,?,?,?,?)`,
    at, n, fitness_yield, recency_yield, threshold, adopted ? 1 : 0, reason);
  if (adopted) await run(ctx.db, `UPDATE signals_fitness SET threshold = ?, experiment_id = ?, set_at = ? WHERE id = 1`, threshold, ins.meta.last_row_id, at);
  return { adopted, reason, threshold: await fitnessThreshold(ctx) };
}

// ---- L1 triage ---------------------------------------------------------------------------------

const clamp = v => Math.max(0, Math.min(1, Number(v)));
/**
 * Decide ACCEPT, LOG or IGNORE for every proposed signal. While the fitness threshold is null the two-model scorecard
 * decides: the mean of two independent scores times the evidential weight; two models that disagree cannot accept.
 */
export async function triage(ctx) {
  const c = cfg(ctx), out = { triaged: 0, accept: 0, log: 0, ignore: 0, method: 'scorecard' };
  const threshold = await fitnessThreshold(ctx);
  const useFitness = threshold !== null && typeof ctx.fitness === 'function';
  const scorers = ctx.scorers || [];
  if (!useFitness && scorers.length < 2) return { ...out, skipped: 'scorecard_needs_two_models' };
  out.method = useFitness ? 'fitness' : 'scorecard';
  for (const s of await all(ctx.db, `SELECT * FROM signals_signals WHERE status = 'proposed' ORDER BY ts, id LIMIT ?`, c.triage_batch)) {
    let score, decision;
    if (useFitness) {
      const f = await ctx.fitness(s);
      score = Number(f.effort) > 0 ? Number(f.expected_reduction) / Number(f.effort) : 0;
      decision = score > threshold ? 'ACCEPT' : score > 0 ? 'LOG' : 'IGNORE';
    } else {
      const a = clamp(await scorers[0](s)), b = clamp(await scorers[1](s));
      score = ((a + b) / 2) * s.evidential_weight;
      decision = score >= c.accept_at ? 'ACCEPT' : score >= c.log_at ? 'LOG' : 'IGNORE';
      if (decision === 'ACCEPT' && Math.abs(a - b) > c.disagreement) decision = 'LOG';
    }
    await run(ctx.db, `UPDATE signals_signals SET status = 'triaged', decision = ?, score = ?, triage_method = ? WHERE id = ? AND status = 'proposed'`, decision, score, out.method, s.id);
    out.triaged++; out[decision.toLowerCase()]++;
  }
  return out;
}

// ---- L2 boundary (US-12-R02, R03) --------------------------------------------------------------

/** Add or change a boundary row. A domain that is not on the configured list is refused (cross-domain guard). */
export async function permit(ctx, { worker, source, domain, permitted = true, note = null }) {
  if (!worker || !source || !domain) throw new Error('a boundary row names worker, source and domain');
  if (!cfg(ctx).domains.includes(domain)) throw new Error(`domain ${domain} is not listed`);
  await run(ctx.db, `INSERT INTO signals_boundary (worker, source, permitted, domain, note) VALUES (?,?,?,?,?)
    ON CONFLICT(worker, source) DO UPDATE SET permitted=excluded.permitted, domain=excluded.domain, note=excluded.note`, worker, source, permitted ? 1 : 0, domain, note);
}
/**
 * The worker presents the signal it intends to consume. No row: deny. Row with permitted = 0: deny. Domain mismatch or an
 * unlisted domain: deny. A denial is an incident row and a return value, never an exception, so the worker's other work goes on.
 */
export async function consume(ctx, { worker, signal_id }) {
  const s = await first(ctx.db, `SELECT * FROM signals_signals WHERE id = ?`, signal_id);
  if (!s) return { permitted: false, reason: 'no_signal' };
  const row = await first(ctx.db, `SELECT * FROM signals_boundary WHERE worker = ? AND source = ?`, worker, s.source);
  let reason = null;
  if (!row) reason = 'no_boundary_row';
  else if (!row.permitted) reason = 'not_permitted';
  else if (!cfg(ctx).domains.includes(row.domain)) reason = 'domain_not_listed';
  else if ((s.domain ?? null) !== row.domain) reason = 'cross_domain';
  if (reason) {
    await incident(ctx, 'boundary_denial', { worker, source: s.source, domain: s.domain, ref: s.id, detail: reason });
    return { permitted: false, reason };
  }
  return { permitted: true, signal: s };
}

// ---- L3 synthesis ------------------------------------------------------------------------------

/** Build a candidate artifact from the accepted signals the worker is permitted to read. Denied signals are skipped, not fatal. */
export async function synthesize(ctx, { worker, signal_ids, id, type = 'note' }) {
  if (typeof ctx.synthesize !== 'function') throw new Error('no synthesize port');
  const used = [], denied = [], skipped = [];
  for (const sid of signal_ids) {
    const r = await consume(ctx, { worker, signal_id: sid });
    if (!r.permitted) { denied.push({ id: sid, reason: r.reason }); continue; }
    if (r.signal.decision !== 'ACCEPT') { skipped.push({ id: sid, reason: `decision ${r.signal.decision ?? 'none'}` }); continue; }
    used.push(r.signal);
  }
  if (!used.length) return { artifact_id: null, used: [], denied, skipped };
  const a = await ctx.synthesize(used);
  if (!a || !a.title || !a.content) throw new Error('synthesis must return a title and content');
  const at = iso(nowMs(ctx)), artifactId = id || `art-${at.replace(/[- :]/g, '')}-${(await first(ctx.db, `SELECT COUNT(*) AS n FROM signals_artifacts`)).n + 1}`;
  const assertions = (a.assertions || []).map(String);
  const lost = assertions.filter(x => !norm(a.content).includes(norm(x)));
  if (lost.length) throw new Error('every assertion must appear in the content');
  await run(ctx.db, `INSERT INTO signals_artifacts (id, type, title, abstract, content, assertions, source_signals, made_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    artifactId, type, String(a.title), a.abstract ?? null, String(a.content), JSON.stringify(assertions), JSON.stringify(used.map(s => s.id)), worker, at);
  return { artifact_id: artifactId, used: used.map(s => s.id), denied, skipped };
}

// ---- L4 ignorance audit ------------------------------------------------------------------------

/** U(a): the questions of the fixed audit list that the artifact does not answer. Recorded on the artifact. */
export async function audit(ctx, artifact_id) {
  if (typeof ctx.auditor !== 'function') throw new Error('no auditor port');
  const a = await first(ctx.db, `SELECT * FROM signals_artifacts WHERE id = ?`, artifact_id);
  if (!a) throw new Error(`artifact ${artifact_id} not found`);
  const open = [];
  for (const q of cfg(ctx).audit_questions) if (!(await ctx.auditor(a, q))) open.push(q);
  await run(ctx.db, `UPDATE signals_artifacts SET open_questions = ?, state = CASE WHEN state = 'candidate' THEN 'audited' ELSE state END WHERE id = ?`, JSON.stringify(open), artifact_id);
  return { artifact_id, open_questions: open, count: open.length };
}

// ---- L5 refinement: the strict-shrink rule (US-12-R07) -----------------------------------------

/**
 * Accept a revision only if its open-question set is a strict subset of the current one (nothing reopened, at least one
 * closed). A shrink obtained by removing a result-asserting statement is narrowing: logged as a violation and rejected.
 * `open_questions` is the revision's audited U; without it the auditor port audits the revised content.
 */
export async function revise(ctx, artifact_id, { content, open_questions = null, assertions = null } = {}) {
  const a = await first(ctx.db, `SELECT * FROM signals_artifacts WHERE id = ?`, artifact_id);
  if (!a) throw new Error(`artifact ${artifact_id} not found`);
  if (typeof content !== 'string' || !content) throw new Error('a revision carries content');
  const before = list(a.open_questions), at = iso(nowMs(ctx));
  const book = async (accepted, reason, after, detail = null) => {
    await run(ctx.db, `INSERT INTO signals_revisions (artifact_id, at, before_count, after_count, accepted, reason, detail) VALUES (?,?,?,?,?,?,?)`,
      artifact_id, at, before ? before.length : 0, after, accepted ? 1 : 0, reason, detail);
    return { accepted, reason, before: before ? before.length : null, after };
  };
  if (!before) return book(false, 'not_audited', 0, 'U(a) is not recorded: audit the artifact first');
  let after = open_questions;
  if (!Array.isArray(after)) {
    if (typeof ctx.auditor !== 'function') throw new Error('a revision needs its open questions or an auditor port');
    after = [];
    for (const q of cfg(ctx).audit_questions) if (!(await ctx.auditor({ ...a, content }, q))) after.push(q);
  }
  const was = new Set(before);
  const strict = after.length < before.length && after.every(q => was.has(q));
  if (!strict) return book(false, 'no_shrink', after.length, after.some(q => !was.has(q)) ? 'the revision reopened or added a question' : null);
  const kept = Array.isArray(assertions) ? assertions.map(String) : list(a.assertions) || [];
  const body = norm(content);
  const removed = (list(a.assertions) || []).filter(x => !body.includes(norm(x)) || !kept.some(k => norm(k) === norm(x)));
  if (removed.length) {
    await incident(ctx, 'narrowing', { ref: artifact_id, detail: `${removed.length} result-asserting statement(s) removed: ${removed.map(r => r.slice(0, 60)).join(' | ')}` });
    return book(false, 'narrowing', after.length, `${removed.length} assertion(s) removed`);
  }
  await run(ctx.db, `UPDATE signals_artifacts SET content = ?, open_questions = ?, assertions = ? WHERE id = ?`, content, JSON.stringify(after), JSON.stringify(kept), artifact_id);
  return book(true, 'strict_shrink', after.length);
}

// ---- L7 deposit --------------------------------------------------------------------------------

/** Deposit with attribution, a deposit identity and a stored re-entry weight. An artifact that failed review stores weight 0. */
export async function deposit(ctx, artifact_id, { deposit_id, attribution, review, reentry_weight, state = 'deposited' } = {}) {
  const a = await first(ctx.db, `SELECT id FROM signals_artifacts WHERE id = ?`, artifact_id);
  if (!a) throw new Error(`artifact ${artifact_id} not found`);
  if (!deposit_id || !attribution) throw new Error('a deposit needs a deposit identity and an attribution');
  if (!['verified', 'clean', 'failed'].includes(review)) throw new Error('review is verified, clean or failed');
  if (!isWeight(reentry_weight)) throw new Error('the re-entry weight is stored at deposit: give a number from 0 to 1');
  if (review === 'failed' && reentry_weight !== 0) throw new Error('an artifact that failed review stores weight 0');
  if (!['deposited', 'published', 'distributed'].includes(state)) throw new Error('state is deposited, published or distributed');
  await run(ctx.db, `UPDATE signals_artifacts SET deposit_id = ?, attribution = ?, review = ?, reentry_weight = ?, state = ?, deposited_at = ? WHERE id = ?`,
    String(deposit_id), String(attribution), review, reentry_weight, state, iso(nowMs(ctx)), artifact_id);
  return { artifact_id, deposit_id, state };
}
export async function setState(ctx, artifact_id, state) {
  if (!['published', 'distributed'].includes(state)) throw new Error('state is published or distributed');
  const r = await run(ctx.db, `UPDATE signals_artifacts SET state = ? WHERE id = ? AND deposit_id IS NOT NULL`, state, artifact_id);
  if (!r.meta.changes) throw new Error('only a deposited artifact can be published or distributed');
}

// ---- L8 re-entry (US-12-R04, R05, R06) ---------------------------------------------------------

/**
 * Every deposited, published or distributed artifact re-enters once as a signal with source `artifact_reentry`; the deposit
 * identity is the idempotency key. No recorded U(a): weight 0, status `logged`. Otherwise the stored weight, status
 * `proposed`, so the next triage reads it (L8 back to L1).
 */
export async function reenter(ctx) {
  const c = cfg(ctx), at = iso(nowMs(ctx)), out = { entered: [], logged: [] };
  const ph = c.reentry_states.map(() => '?').join(',');
  const rows = await all(ctx.db, `SELECT * FROM signals_artifacts WHERE deposit_id IS NOT NULL AND state IN (${ph})
    AND deposit_id NOT IN (SELECT source_ref FROM signals_signals WHERE source = 'artifact_reentry' AND source_ref IS NOT NULL) ORDER BY id`, ...c.reentry_states);
  for (const a of rows) {
    const u = list(a.open_questions);
    const empty = !u || u.length === 0;
    let weight = empty ? 0 : a.reentry_weight;
    if (!empty && !isWeight(weight)) { weight = 0; await incident(ctx, 'unstored_weight', { ref: a.id, detail: 'no stored re-entry weight: entered at 0, not inferred' }); }
    const logged = empty || !isWeight(a.reentry_weight);
    const content = [a.title, a.abstract || '', a.deposit_id, u && u.length ? `Open questions: ${u.join('; ')}` : 'Open questions: none recorded'].join('\n');
    const r = await run(ctx.db, `INSERT OR IGNORE INTO signals_signals (id, ts, source, source_ref, content, open_questions, evidential_weight, domain, status, decision, created_at)
      VALUES (?,?, 'artifact_reentry', ?,?,?,?,?,?,?,?)`, `reentry-${a.id}`, at, a.deposit_id, content, JSON.stringify(u || []), weight, c.reentry_domain ?? null,
      logged ? 'logged' : 'proposed', logged ? 'LOG' : null, at);
    if (r.meta.changes) (logged ? out.logged : out.entered).push(a.id);
  }
  return out;
}

// ---- surface for the composition root ----------------------------------------------------------

export async function status(ctx) {
  const by = Object.fromEntries((await all(ctx.db, `SELECT status, COUNT(*) AS n FROM signals_signals GROUP BY status`)).map(r => [r.status, r.n]));
  const n = async sql => (await first(ctx.db, sql)).n;
  return {
    signals: by, fitness_threshold: await fitnessThreshold(ctx),
    boundary_denials: await n(`SELECT COUNT(*) AS n FROM signals_incidents WHERE kind = 'boundary_denial'`),
    narrowing_violations: await n(`SELECT COUNT(*) AS n FROM signals_incidents WHERE kind = 'narrowing'`),
    artifacts: await n(`SELECT COUNT(*) AS n FROM signals_artifacts`),
    deposited_not_reentered: await n(`SELECT COUNT(*) AS n FROM signals_artifacts WHERE deposit_id IS NOT NULL AND state IN ('published','distributed')
      AND deposit_id NOT IN (SELECT source_ref FROM signals_signals WHERE source = 'artifact_reentry' AND source_ref IS NOT NULL)`),
  };
}
/** One tick: re-enter deposited artifacts, then triage everything proposed. */
export async function step(ctx) {
  if (cfg(ctx).enabled === false) return { enabled: false };
  const re = await reenter(ctx);
  return { reentered: re.entered.length, logged: re.logged.length, triage: await triage(ctx) };
}
