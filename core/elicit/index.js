// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Elicitation (US-SPEC-16, issue #60): the front door for a person who does not know what they do not know.
// A needs register, Ask cards answerable by recognition, stated defaults with an assumption log, a read-back with provenance,
// a computed readiness score, and a four-sweep ignorance audit. Ports only: db, now. No agent interprets an answer: an
// answer maps to a register write deterministically (US-16-R07).
export const EXTRA_OPTIONS = ['Not sure', 'Tell me more'];
export const DEFAULT_JARGON = ['schema', 'architecture', 'stack', 'api', 'endpoint', 'database', 'repository', 'deploy', 'oauth', 'webhook', 'backend', 'frontend', 'latency'];
const PROFESSIONAL = /legal|law|tax|medical|health|financ|safety|privacy notice|licen[cs]e/i;
const SWEEPS = ['catalog', 'analogy', 'redteam', 'surprise'];
const SATISFIED = ['answered', 'defaulted', 'derived'];
const words = s => String(s || '').trim().split(/\s+/).filter(Boolean);
const iso = ms => new Date(ms).toISOString();
const priorityOf = n => Number(n.p_wrong) * Number(n.rework) * Number(n.dependents);

/** Problems with an Ask card, or [] (US-16-R02, R03, section 5.1, T16-2). `defines` lists jargon terms the card explains itself. */
export function validateCard(card, { jargon = DEFAULT_JARGON } = {}) {
  const p = [];
  for (const f of ['need_id', 'question', 'why', 'cue', 'default', 'default_consequence', 'reversibility', 'priority']) {
    if (card[f] === undefined || card[f] === null || card[f] === '') p.push(`missing ${f}`);
  }
  if (words(card.question).length > 25) p.push('question is longer than 25 words');
  if (!['reversible', 'not reversible'].includes(card.reversibility)) p.push('reversibility must be reversible or not reversible');
  const opts = Array.isArray(card.options) ? card.options : [];
  const real = opts.filter(o => !EXTRA_OPTIONS.includes(o));
  if (!card.free_text && (real.length < 2 || real.length > 4)) p.push('options must be two to four');
  if (!EXTRA_OPTIONS.every(o => opts.includes(o))) p.push('options must include Not sure and Tell me more');
  const text = [card.question, card.why, card.cue, ...real].join(' ').toLowerCase();
  const defined = (card.defines || []).map(x => String(x).toLowerCase());
  for (const j of jargon) if (new RegExp(`\\b${j}\\b`).test(text) && !defined.includes(j)) p.push(`jargon without definition: ${j}`);
  return p;
}

export function createElicit({ db, now = () => Date.now(), config = {} } = {}) {
  const clock = typeof now === 'function' ? now : () => now;
  const cfg = { max_open: 3, daily_cap: 5, quiet: null, expiry_hours: 72, spend_cap_usd: 0, defer_below: 0, g1_threshold: 0.7, jargon: DEFAULT_JARGON, ...config };
  const all = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
  const one = (sql, ...a) => db.prepare(sql).bind(...a).first();
  const run = (sql, ...a) => db.prepare(sql).bind(...a).run();
  const needRow = (project, id) => one(`SELECT * FROM elicit_needs WHERE project=? AND id=?`, project, id);
  const gateId = (project, id) => `elicit-${project}-${id}`;
  const gated = n => !n.reversible || !!n.identity_bound || !!n.exposes_private || n.cost_usd > cfg.spend_cap_usd;
  const quiet = () => {
    if (!cfg.quiet) return false;
    const h = new Date(clock()).getUTCHours(); const { from, to } = cfg.quiet;
    return from > to ? (h >= from || h < to) : (h >= from && h < to);
  };

  const toCard = n => ({
    need_id: n.id, question: n.question, why: n.why, cue: n.cue,
    options: [...JSON.parse(n.options), ...EXTRA_OPTIONS], default: n.default_value, default_marked: true,
    default_consequence: n.default_consequence, reversibility: n.reversible ? 'reversible' : 'not reversible',
    priority: n.priority, free_text: !!n.free_text, defines: [],
  });

  async function setDefault(n, reason) {
    const t = iso(clock());
    await run(`UPDATE elicit_needs SET state='defaulted', value=?, provenance='default', answered_at=?, revisit='at the next demonstration or review' WHERE project=? AND id=?`, n.default_value, t, n.project, n.id);
    await run(`INSERT INTO elicit_assumptions (project, need_id, value, reason, revisit_trigger, created_at) VALUES (?,?,?,?,?,?)`,
      n.project, n.id, n.default_value, reason, 'revisit at the next demonstration or review, or when the person answers', t);
  }

  return {
    config: cfg,
    toCard,

    /** Build the needs register from a catalog (the REQUIRED artifact fields), deriving what the idea text already answers (US-16-R01, T16-1). */
    async registerNeeds(project, catalog, { idea = '' } = {}) {
      const rejected = [];
      for (const c of catalog) {
        const problems = validateCard({
          need_id: c.id, question: c.question, why: c.why, cue: c.cue, options: [...(c.options || []), ...EXTRA_OPTIONS], free_text: c.free_text,
          default: c.default ?? 'unset', default_consequence: c.default_consequence || 'x', reversibility: c.reversible === false ? 'not reversible' : 'reversible', priority: 0, defines: c.defines,
        }, { jargon: cfg.jargon });
        if (problems.length) { rejected.push({ id: c.id, problems }); continue; }
        const m = c.derive_from ? new RegExp(c.derive_from, 'i').exec(idea) : null;
        const priority = priorityOf({ p_wrong: c.p_wrong ?? 0.5, rework: c.rework ?? 1, dependents: c.dependents ?? 1 });
        await run(`INSERT OR IGNORE INTO elicit_needs (project, id, label, artifact, must, reversible, identity_bound, exposes_private, cost_usd, question, why, cue, options, default_value, default_consequence,
          free_text, p_wrong, rework, dependents, priority, state, value, provenance, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        project, c.id, c.label, c.artifact, c.must === false ? 0 : 1, c.reversible === false ? 0 : 1, c.identity_bound ? 1 : 0, c.exposes_private ? 1 : 0, c.cost_usd || 0,
        c.question, c.why, c.cue, JSON.stringify(c.options || []), c.default ?? null, c.default_consequence || null, c.free_text ? 1 : 0, c.p_wrong ?? 0.5, c.rework ?? 1, c.dependents ?? 1, priority,
        m ? 'derived' : 'open', m ? m[0] : null, m ? 'derived' : null, m ? 'idea file' : null);
      }
      return { registered: (await all(`SELECT id FROM elicit_needs WHERE project=?`, project)).length, rejected };
    },

    /** Move needs forward: expire old asks, file gate cards for needs that cannot be defaulted, default low-priority reversible needs,
     *  then open Asks up to the open cap, the daily cap and the quiet period (US-16-R04, R06, R10, R16). Returns the open Ask cards. */
    async nextAsks(project) {
      await this.expire(project);
      for (const n of await all(`SELECT * FROM elicit_needs WHERE project=? AND state='open' ORDER BY priority DESC, id`, project)) {
        if (gated(n)) {
          await run(`UPDATE elicit_needs SET state='gated', asked_at=? WHERE project=? AND id=?`, iso(clock()), project, n.id);
          await run(`INSERT OR IGNORE INTO gate_cards (id, what, why_gated, default_in_effect, prepared_by_fleet, closing_probe) VALUES (?,?,?,?,?,?)`,
            gateId(project, n.id), `answer needed: ${n.label}`, 'A wrong default here could not be undone, would use the person identity, spend above the cap or expose private data.',
            'work that depends on this waits; other work continues', 'elicit', `elicit_answered:${project}:${n.id}`);
        } else if (n.priority < cfg.defer_below && n.default_value != null) await setDefault(n, 'low_priority');
      }
      if (!quiet()) {
        const open = (await one(`SELECT COUNT(*) AS n FROM elicit_needs WHERE project=? AND state='asked'`, project)).n;
        const day = iso(clock()).slice(0, 10);
        const today = (await one(`SELECT COUNT(*) AS n FROM elicit_needs WHERE project=? AND state<>'gated' AND substr(asked_at,1,10)=?`, project, day)).n;
        const room = Math.max(0, Math.min(cfg.max_open - open, cfg.daily_cap - today));
        for (const n of await all(`SELECT id FROM elicit_needs WHERE project=? AND state='open' ORDER BY priority DESC, id LIMIT ?`, project, room)) {
          await run(`UPDATE elicit_needs SET state='asked', asked_at=?, expires_at=? WHERE project=? AND id=?`, iso(clock()), iso(clock() + cfg.expiry_hours * 3600e3), project, n.id);
        }
      }
      return (await all(`SELECT * FROM elicit_needs WHERE project=? AND state IN ('asked','gated') ORDER BY priority DESC, id`, project)).map(toCard);
    },

    /** An unanswered Ask becomes its default after its time (US-16-R10). Gated needs never expire to a default. */
    async expire(project) {
      let n = 0;
      for (const r of await all(`SELECT * FROM elicit_needs WHERE project=? AND state='asked' AND expires_at<=?`, project, iso(clock()))) {
        if (r.default_value == null) continue;
        await setDefault(r, 'timeout'); n++;
      }
      return n;
    },

    /** Record an answer. `choice` is an option, `Not sure` (default plus assumption log) or `Tell me more` (explain, same card). */
    async answer(project, id, { choice, text, channel = 'console' } = {}) {
      const n = await needRow(project, id);
      if (!n) return { ok: false, error: 'no such need' };
      if (choice === 'Tell me more') {
        await run(`UPDATE elicit_needs SET more_count = more_count + 1 WHERE project=? AND id=?`, project, id);
        const count = n.more_count + 1;
        if (count >= 3) await run(`INSERT OR IGNORE INTO elicit_glossary (term, plain, created_at) VALUES (?,?,?)`, n.label.toLowerCase(), n.why, iso(clock()));
        return { ok: true, explain: `${n.why} For example: ${n.cue}`, card: toCard(n), taught: count >= 3 };
      }
      if (choice === 'Not sure') {
        if (gated(n) || n.default_value == null) return { ok: false, refusal: 'cannot_default', error: 'this one has no safe default; it stays with the person', card: toCard(n) };
        await setDefault(n, 'not_sure');
        return { ok: true, state: 'defaulted', value: n.default_value };
      }
      const options = JSON.parse(n.options);
      const value = n.free_text ? String(choice ?? text ?? '').trim() : choice;
      if (!value || (!n.free_text && !options.includes(value))) return { ok: false, error: 'answer must be one of the options' };
      await run(`UPDATE elicit_needs SET state='answered', value=?, provenance='stated', answer_text=?, channel=?, answered_at=?, revisit=NULL WHERE project=? AND id=?`, value, text ?? String(choice), channel, iso(clock()), project, id);
      await run(`UPDATE elicit_assumptions SET superseded_at=? WHERE project=? AND need_id=? AND superseded_at IS NULL`, iso(clock()), project, id);
      await run(`UPDATE gate_cards SET status='closed', closed_at=datetime('now') WHERE id=? AND status='open'`, gateId(project, id));
      return { ok: true, state: 'answered', value };
    },

    /** Computed, never asserted (US-16-R15). G1 needs g1_threshold; G2 needs every MUST need satisfied and every non-reversible one answered or derived (T16-7). */
    async readiness(project) {
      const musts = await all(`SELECT id, state, reversible FROM elicit_needs WHERE project=? AND must=1`, project);
      const ok = musts.filter(n => SATISFIED.includes(n.state));
      const score = musts.length ? ok.length / musts.length : 1;
      const blocking = musts.filter(n => !n.reversible && !['answered', 'derived'].includes(n.state)).map(n => n.id);
      return { score, musts: musts.length, satisfied: ok.length, g1: score >= cfg.g1_threshold, g2: score === 1 && !blocking.length, blocking, missing: musts.filter(n => !SATISFIED.includes(n.state)).map(n => n.id) };
    },

    /** The spec restated in plain words, defaults first, every statement tagged with its provenance (US-16-R11, R12). */
    async readBack(project) {
      const rows = await all(`SELECT * FROM elicit_needs WHERE project=? AND state IN ('answered','defaulted','derived') ORDER BY (state='defaulted') DESC, artifact, id`, project);
      const log = await all(`SELECT id, need_id FROM elicit_assumptions WHERE project=? AND superseded_at IS NULL`, project);
      const statements = rows.map(n => ({
        need_id: n.id, provenance: n.provenance, value: n.value, artifact: n.artifact, assumption: n.provenance === 'default',
        assumption_id: n.provenance === 'default' ? (log.find(a => a.need_id === n.id)?.id ?? null) : null,
        text: n.provenance === 'default' ? `We assumed ${n.label.toLowerCase()} is "${n.value}". If that is wrong: ${n.default_consequence}` : `${n.label}: ${n.value}`,
      }));
      return { statements, text: statements.map(s => `- ${s.text} [${s.provenance}]`).join('\n'), defaults: statements.filter(s => s.assumption).length };
    },

    /** A correction from the read-back: updates the register and queues a re-run of the artifact it feeds (US-16-R13, T16-8). */
    async correct(project, id, value, { channel = 'console', text } = {}) {
      const n = await needRow(project, id);
      if (!n) return { ok: false, error: 'no such need' };
      await run(`UPDATE elicit_needs SET state='answered', value=?, provenance='stated', answer_text=?, channel=?, answered_at=?, revisit=NULL WHERE project=? AND id=?`, String(value), text ?? String(value), channel, iso(clock()), project, id);
      await run(`UPDATE elicit_assumptions SET superseded_at=? WHERE project=? AND need_id=? AND superseded_at IS NULL`, iso(clock()), project, id);
      const itemId = `ELICIT-RERUN-${project}-${n.artifact}`.toUpperCase().replace(/[^A-Z0-9-]+/g, '-');
      await run(`INSERT INTO items (id, title, kind, project, owner_role, done_check, closing_probe, priority, status) VALUES (?,?,'work',?,'portfolio-manager',?,'manual',15,'open')
        ON CONFLICT(id) DO UPDATE SET status='open', updated_at=datetime('now')`, itemId, `Re-run ${n.artifact}: the person corrected "${n.label}"`, project, `${n.artifact} regenerated from the corrected need ${id}`);
      return { ok: true, rerun: [itemId] };
    },

    /** The four-sweep ignorance audit (section 6, T16-9). Inputs are data; the red-team sweep is an injected function and must come from a
     *  different model family than the author. Evidence rows are written for every sweep that ran; `complete` is true only if all four did. */
    async audit(project, { required_fields = [], analogies = [], redteam, author_family = null, surprises = [] } = {}) {
      const run_id = `AUD-${clock().toString(36)}`;
      const t = iso(clock());
      const add = (sweep, finding, disposition, evidence) => run(`INSERT INTO elicit_audit (project, run_id, sweep, finding, disposition, evidence, created_at) VALUES (?,?,?,?,?,?,?)`, project, run_id, sweep, finding, disposition, evidence ?? null, t);
      const ran = new Set();
      const known = new Set((await all(`SELECT artifact, label FROM elicit_needs WHERE project=?`, project)).map(n => `${n.artifact}:${n.label}`));
      const missing = required_fields.filter(f => !known.has(`${f.artifact}:${f.field}`));
      for (const f of missing) await add('catalog', `${f.artifact}.${f.field} has no need in the register`, 'need', 'catalog diff');
      await add('catalog', `checked ${required_fields.length} required fields; ${missing.length} without a need`, 'dismissed', 'catalog diff');
      ran.add('catalog');
      for (const a of analogies) {
        const pro = PROFESSIONAL.test(a.item) || PROFESSIONAL.test(a.topic || '');
        const disp = pro ? 'needs_professional' : (a.disposition || 'risk');
        await add('analogy', `${a.topic ? a.topic + ': ' : ''}${a.item}`, disp, a.source ? `source: ${a.source}` : 'no source');
        if (pro) {
          await run(`INSERT OR IGNORE INTO gate_cards (id, what, why_gated, default_in_effect, prepared_by_fleet, closing_probe) VALUES (?,?,?,?,?,?)`,
            `elicit-pro-${project}-${run_id}-${(a.topic || a.item).slice(0, 20).replace(/[^A-Za-z0-9]+/g, '-')}`, `needs a qualified professional: ${a.item}`,
            'The system does not give legal, medical, financial or safety advice (SCOPE.md).', 'recorded as a risk; work that does not depend on it continues', 'elicit', 'manual');
        }
      }
      if (analogies.length) ran.add('analogy');
      if (typeof redteam === 'function') {
        const r = await redteam({ project, needs: await all(`SELECT id, label, value, provenance FROM elicit_needs WHERE project=?`, project) });
        if (author_family && r?.family && r.family === author_family) throw new Error('red-team sweep must come from a different model family than the author');
        const ev = `model family: ${r?.family || 'unknown'}`;
        await add('redteam', `question: ${r?.question || 'what would make this fail or harm someone that the person has not mentioned?'}`, 'dismissed', ev);
        for (const pt of r?.points || []) await add('redteam', pt.point, pt.disposition || 'risk', ev);
        ran.add('redteam');
      }
      const misses = await all(`SELECT id, metric FROM predictions WHERE verdict IS NOT NULL AND verdict <> 'hit'`).catch(() => []);
      for (const m of misses) await add('surprise', `failed prediction ${m.id}: ${m.metric}`, 'lesson', 'predictions table');
      for (const s of surprises) await add('surprise', s.what, s.kind || 'lesson', s.evidence || 'runtime record');
      await add('surprise', `reviewed ${misses.length + surprises.length} surprises`, 'dismissed', 'surprise review');
      ran.add('surprise');
      return { run_id, ran: [...ran], missing_sweeps: SWEEPS.filter(s => !ran.has(s)), complete: SWEEPS.every(s => ran.has(s)), new_needs: missing.length };
    },
  };
}
