// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Operator console L3 (US-SPEC-13, US-SPEC-18; issue #46): the fleet view over the L1 console. One state function feeds the
// JSON routes and the digest, so they cannot disagree (US-13-R02). Report cards refuse a score without evidence (R03), carry
// their limits (R04), turn a fall of 0.5 or more without a cause into a work item (R05), and never adopt a change to the
// objective function (R06). Step budgets file one item and, past twice the budget, exactly one blocking question (R11).
// Ports only: db, now, config { version }.
export const LIMITS_MUST_MENTION = /self-measurement|grades itself|self-grad/i;
const CONFIDENCE = ['low', 'medium', 'high'];
const iso = ms => new Date(ms).toISOString();

export function createConsoleL3({ db, now = () => Date.now(), config = {} } = {}) {
  const clock = typeof now === 'function' ? now : () => now;
  const all = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
  const one = (sql, ...a) => db.prepare(sql).bind(...a).first();
  const run = (sql, ...a) => db.prepare(sql).bind(...a).run();
  const version = config.version || 'unversioned';

  /** The one view of the organization (US-13-R01, R02). Everything below is derived from this. */
  async function state() {
    const counts = Object.fromEntries((await all(`SELECT status, COUNT(*) AS n FROM items GROUP BY status`)).map(r => [r.status, r.n]));
    const cards = await all(`SELECT id, what, default_in_effect FROM gate_cards WHERE status='open' ORDER BY id`);
    const tick = await one(`SELECT started_at, finished_at, steps_completed, steps_total FROM tick_runs ORDER BY id DESC LIMIT 1`);
    const pred = await one(`SELECT SUM(verdict='hit') AS hit, SUM(verdict IS NOT NULL) AS scored FROM predictions`);
    const trust = await all(`SELECT surface, action_class, rung, reliability FROM trust_ledger ORDER BY surface, action_class`);
    const waiting = await one(`SELECT COUNT(*) AS n FROM items WHERE status='blocked'`);
    return {
      version, at: iso(clock()),
      items: { open: (counts.open || 0) + (counts.ready || 0), claimed: counts.claimed || 0, blocked: counts.blocked || 0, done: counts.done || 0, total: Object.values(counts).reduce((a, b) => a + b, 0) },
      gate_cards: { open: cards.length, list: cards },
      last_tick: tick ? { ...tick, ok: tick.steps_completed === tick.steps_total, finished: !!tick.finished_at } : null,
      predictions: { hit: pred.hit || 0, scored: pred.scored || 0 },
      trust, waiting_on_a_person: cards.length + (waiting.n || 0),
    };
  }

  /** Liveness and counts (US-13-T01). */
  async function health() {
    const s = await state();
    return { ok: !!s.last_tick?.ok, version: s.version, at: s.at, counts: { items: s.items.total, open_gate_cards: s.gate_cards.open, blocked: s.items.blocked } };
  }

  /** The digest is the state, worded. It reads the same function the dashboard reads (US-13-R02). */
  async function digest() {
    const s = await state();
    const lines = [
      `Items: ${s.items.open} open, ${s.items.claimed} in progress, ${s.items.blocked} blocked, ${s.items.done} done.`,
      `Decisions waiting on a person: ${s.waiting_on_a_person}.`,
      s.last_tick ? `Last check: ${s.last_tick.ok ? 'finished all steps' : 'did not finish'} (${s.last_tick.steps_completed} of ${s.last_tick.steps_total}).` : 'The first check has not run yet.',
      `Predictions: ${s.predictions.hit} of ${s.predictions.scored} called right.`,
    ];
    return { state: s, text: lines.join('\n') };
  }

  /** Record a report card. Every score needs evidence, a confidence and a status; the card must state its limits including
   *  self-measurement bias (R03, R04). A dimension that fell 0.5 or more since its last score, with no cause, files a work item (R05). */
  async function recordCard({ name, rubric, limits, scores = [] } = {}) {
    const errors = [];
    if (!name || !rubric) errors.push('name and rubric are required');
    if (!limits || !LIMITS_MUST_MENTION.test(limits)) errors.push('limits must state self-measurement bias (the system grades itself)');
    if (!scores.length) errors.push('at least one score is required');
    scores.forEach((s, i) => {
      const at = `score ${i} (${s?.dimension ?? '?'})`;
      if (!s?.dimension) errors.push(`${at}: dimension is required`);
      if (typeof s?.score !== 'number' || !Number.isFinite(s.score)) errors.push(`${at}: score must be a number`);
      if (!String(s?.evidence || '').trim()) errors.push(`${at}: evidence pointer is required, a score without evidence is not accepted`);
      if (!CONFIDENCE.includes(s?.confidence)) errors.push(`${at}: confidence must be one of ${CONFIDENCE.join(', ')}`);
      if (!String(s?.status || '').trim()) errors.push(`${at}: status is required`);
    });
    if (errors.length) return { ok: false, errors };
    const t = iso(clock());
    const card = await run(`INSERT INTO l3_cards (name, rubric, limits, at) VALUES (?,?,?,?)`, name, rubric, limits, t);
    const cardId = card.meta.last_row_id;
    const items = [];
    for (const s of scores) {
      const prev = await one(`SELECT score FROM l3_scores WHERE name=? AND dimension=? ORDER BY id DESC LIMIT 1`, name, s.dimension);
      await run(`INSERT INTO l3_scores (card_id, name, dimension, score, evidence, confidence, status, cause, at) VALUES (?,?,?,?,?,?,?,?,?)`,
        cardId, name, s.dimension, s.score, s.evidence, s.confidence, s.status, s.cause ?? null, t);
      if (prev && prev.score - s.score >= 0.5 && !String(s.cause || '').trim()) {
        const id = `L3-DROP-${name}-${s.dimension}`.toUpperCase().replace(/[^A-Z0-9-]+/g, '-');
        await run(`INSERT INTO items (id, title, kind, project, owner_role, done_check, closing_probe, priority, status) VALUES (?,?,'work','report-card','portfolio-manager',?,'manual',20,'open')
          ON CONFLICT(id) DO UPDATE SET status='open', updated_at=datetime('now')`, id, `${name}: ${s.dimension} fell from ${prev.score} to ${s.score} with no documented cause`, `cause of the fall in ${s.dimension} recorded with evidence`);
        items.push(id);
      }
    }
    return { ok: true, card_id: cardId, items };
  }

  /** The latest score per dimension for a card name, with limits attached. */
  async function reportCard(name) {
    const card = await one(`SELECT id, name, rubric, limits, at FROM l3_cards WHERE name=? ORDER BY id DESC LIMIT 1`, name);
    if (!card) return null;
    const scores = await all(`SELECT dimension, score, evidence, confidence, status, cause FROM l3_scores WHERE card_id=? ORDER BY dimension`, card.id);
    const mean = scores.length ? scores.reduce((a, s) => a + s.score, 0) / scores.length : null;
    return { ...card, scores, overall: mean };
  }

  /** The system MAY propose a change to its objective function; it never adopts one (US-13-R06). */
  async function proposeObjectiveChange(text) {
    const t = String(text || '').trim();
    if (!t) return { ok: false, error: 'proposal text required' };
    const r = await run(`INSERT INTO l3_proposals (text, status, at) VALUES (?, 'proposed', ?)`, t, iso(clock()));
    return { ok: true, id: r.meta.last_row_id, status: 'proposed' };
  }
  const adoptObjectiveChange = async () => ({ ok: false, refusal: 'objective_function_is_not_self_adoptable', error: 'the system may propose a change to its objective function but may not adopt it' });

  /** Per-step budgets (US-13-R11, T04). runs: [{ process, step, started_at (ms or ISO), budget_hours, done? }].
   *  Over budget: one item keyed (process, step). Over twice the budget: also exactly one blocking question (a gate card), never a second. */
  async function sweepStepBudgets(runs = []) {
    const filed = [];
    for (const r of runs) {
      if (r.done) continue;
      const started = typeof r.started_at === 'number' ? r.started_at : Date.parse(r.started_at);
      const hours = (clock() - started) / 3600e3;
      const key = `${r.process}-${r.step}`.toUpperCase().replace(/[^A-Z0-9-]+/g, '-');
      if (hours > r.budget_hours) {
        await run(`INSERT OR IGNORE INTO items (id, title, kind, project, owner_role, done_check, closing_probe, priority, status) VALUES (?,?,'fix','step-budget','portfolio-manager',?,'manual',25,'open')`,
          `STEPBUDGET-${key}`, `${r.process} / ${r.step} is over its ${r.budget_hours} h budget`, `${r.process} / ${r.step} finishes or its budget is justified`);
        filed.push({ key, kind: 'item' });
      }
      if (hours > 2 * r.budget_hours) {
        const w = await run(`INSERT OR IGNORE INTO gate_cards (id, what, why_gated, default_in_effect, prepared_by_fleet, closing_probe) VALUES (?,?,?,?,?,?)`,
          `stepq-${key}`.toLowerCase(), `${r.process} / ${r.step} has run ${hours.toFixed(1)} h against a ${r.budget_hours} h budget: what is blocking it?`,
          'The step is past twice its time budget.', 'the step keeps running; the item stays open', 'console-l3', `item_done:STEPBUDGET-${key}`);
        if (w.meta.changes) filed.push({ key, kind: 'question' });
      }
    }
    return filed;
  }

  /** Routes: GET /health, /api/state, /api/report-card?name=. Returns null for other paths. Auth is the caller's job
   *  (the console routes the /api/console/fleet prefix behind its sign-in). */
  async function handle(request) {
    const url = new URL(request.url);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    if (request.method !== 'GET') return null;
    if (url.pathname === '/health') return json(await health());
    if (url.pathname === '/api/state') return json(await state());
    if (url.pathname === '/api/digest') return json(await digest());
    if (url.pathname === '/api/report-card') {
      const c = await reportCard(url.searchParams.get('name') || '');
      return c ? json(c) : json({ error: 'no such report card' }, 404);
    }
    return null;
  }

  return { state, health, digest, recordCard, reportCard, proposeObjectiveChange, adoptObjectiveChange, sweepStepBudgets, handle };
}
