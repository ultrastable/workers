// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Self-amendment loop (US-SPEC-07 section 3, E1 to E7): collect hits, raise a proposal at the threshold, generate the rule,
// check the protected set by code, red-team with a second model, replay against stored scans, adopt by reviewed change with a
// version bump and a lineage row, or reject with the reason. Ports: db, now, generate, redteam { family, attack }, evaluate.
import { all, first, run, iso, hash, registerRows, registerHash, COMMITMENTS, PROTECTED_LIMITS, INITIAL_VERSION } from './register.js';
import { matchDraft } from './engine.js';

const OPEN = ['collected', 'generated', 'redteamed', 'replayed'];
const REGISTER_OPS = ['add_phrase', 'remove_phrase', 'add_pattern', 'deactivate_pattern', 'set_weight'];
const WEAKEN = /\b(remove|removes|removing|disable|disables|bypass|bypasses|ignore|ignores|waive|waives|weaken|weakens|skip|skips|suspend|suspends|relax|relaxes|no longer (?:applies|required|needed))\b/i;

/**
 * E1, E2: a signature that hit 3 times in 7 days from one source, or a friction phrase once, raises one proposal
 * (`collected`), unless an undecided proposal for the same signature and source already exists.
 */
export async function scanThresholds(db, { now = Date.now(), threshold = 3, days = 7 } = {}) {
  const since = iso(now - days * 86400e3), nowIso = iso(now);
  const groups = await all(db, `SELECT pattern_key, source, COUNT(*) AS n FROM governance_false_stop_hits
      WHERE excluded = 0 AND ts >= ? GROUP BY pattern_key, source HAVING COUNT(*) >= ? OR (pattern_key = 'friction' AND COUNT(*) >= 1) ORDER BY pattern_key, source`, since, threshold);
  const made = [];
  for (const g of groups) {
    if (await first(db, `SELECT 1 AS x FROM governance_proposals WHERE pattern_key = ? AND source = ? AND status IN ('${OPEN.join("','")}')`, g.pattern_key, g.source)) continue;
    const hits = await all(db, `SELECT id, ts, excerpt FROM governance_false_stop_hits WHERE pattern_key = ? AND source = ? AND excluded = 0 AND ts >= ? ORDER BY id`, g.pattern_key, g.source, since);
    const id = `AMEND-${g.pattern_key}-${g.source}-${nowIso.slice(0, 10)}`.replace(/[^A-Za-z0-9_.:-]/g, '_');
    if (await first(db, `SELECT 1 AS x FROM governance_proposals WHERE id = ?`, id)) continue;
    await run(db, `INSERT INTO governance_proposals (id, created_at, origin, pattern_key, source, evidence, status) VALUES (?,?,?,?,?,?, 'collected')`,
      id, nowIso, g.pattern_key === 'friction' ? 'friction' : 'threshold', g.pattern_key, g.source, JSON.stringify({ hits: g.n, window_days: days, hit_ids: hits.map(h => h.id), excerpts: hits.slice(0, 5).map(h => h.excerpt) }));
    made.push(id);
  }
  return made;
}

/** A proposal written directly (origin `manual`), for example by an agent that found the defect itself. */
export async function propose(db, p, { now = Date.now() } = {}) {
  if (!p.id || !p.rule_text || !p.author || !p.author_family) throw new Error('proposal requires id, rule_text, author and author_family');
  await run(db, `INSERT INTO governance_proposals (id, created_at, origin, pattern_key, source, rule_text, changes, author, author_family, status) VALUES (?,?,'manual',?,?,?,?,?,?, 'generated')`,
    p.id, iso(now), p.pattern_key ?? null, p.source ?? null, p.rule_text, JSON.stringify(p.changes || []), p.author, p.author_family);
  return { id: p.id, status: 'generated' };
}

/** E3: a model writes the rule and its scope for each collected proposal. `generate` returns { rule_text, changes, author, family }. */
export async function generateRules(db, { generate } = {}) {
  if (typeof generate !== 'function') return [];
  const out = [];
  for (const p of await all(db, `SELECT * FROM governance_proposals WHERE status = 'collected' ORDER BY created_at, id`)) {
    const g = await generate({ id: p.id, pattern_key: p.pattern_key, source: p.source, evidence: JSON.parse(p.evidence || '{}') });
    if (!g || !g.rule_text || !g.family) continue;
    await run(db, `UPDATE governance_proposals SET rule_text=?, changes=?, author=?, author_family=?, status='generated' WHERE id=?`,
      g.rule_text, JSON.stringify(g.changes || []), g.author || 'generator', g.family, p.id);
    out.push(p.id);
  }
  return out;
}

/**
 * US-07-R03, R04: the protected-set check, by code. Returns the reasons an amendment touches a protected limit or a
 * commitment; any reason rejects it without replay.
 */
export async function protectedProblems(db, proposal) {
  const reasons = [];
  const changes = typeof proposal.changes === 'string' ? JSON.parse(proposal.changes || '[]') : proposal.changes || [];
  const text = String(proposal.rule_text || '');
  for (const c of changes) {
    const target = String(c.target || '');
    if (/^(commitment|protected):/.test(target)) reasons.push(`change ${c.op} targets ${target}`);
    if (c.op === 'deactivate_pattern' || c.op === 'remove_phrase') {
      const row = await first(db, `SELECT commitment FROM governance_false_stop_register WHERE pattern_key = ?`, c.pattern_key);
      if (row && row.commitment && c.op === 'deactivate_pattern') reasons.push(`deactivating ${c.pattern_key} removes the enforcement of commitment ${row.commitment}`);
    }
    if (c.op === 'set_weight' && typeof c.weight === 'number' && c.weight > 0) reasons.push(`a recognition weight above zero rewards the false stop ${c.pattern_key}`);
  }
  for (const sentence of text.split(/(?<=[.!?;])\s+|\n/)) {
    if (!WEAKEN.test(sentence)) continue;
    const s = sentence.toLowerCase();
    for (const l of PROTECTED_LIMITS) if (l.terms.some(t => s.includes(t))) reasons.push(`rule text weakens protected limit ${l.key}`);
    const named = COMMITMENTS.filter(c => s.includes(c.key.replace(/-/g, ' ')));
    for (const c of named) reasons.push(`rule text weakens commitment ${c.key}`);
    if (!named.length && s.includes('commitment')) reasons.push('rule text weakens a commitment');
  }
  return [...new Set(reasons)];
}

async function reject(db, id, reason, now, extra = {}) {
  await run(db, `UPDATE governance_proposals SET status='rejected', reason=?, decided_at=?, redteam=COALESCE(?, redteam), replay=COALESCE(?, replay) WHERE id=?`,
    String(reason).slice(0, 500), iso(now), extra.redteam ? JSON.stringify(extra.redteam) : null, extra.replay ? JSON.stringify(extra.replay) : null, id);
  return { id, status: 'rejected', reason };
}

/**
 * E4, US-07-R02, R03: red-team by a second model. The protected-set check runs first, by code; an amendment that modifies a
 * protected limit or a commitment is rejected here and is never replayed (T03). The red-team model must be of a different
 * family from the author; a case where the rule harms a protected limit or a commitment rejects.
 */
export async function redTeam(db, id, { redteam, now = Date.now() } = {}) {
  const p = await first(db, `SELECT * FROM governance_proposals WHERE id = ?`, id);
  if (!p) throw new Error(`unknown proposal ${id}`);
  if (p.status !== 'generated') return { id, status: p.status, reason: 'proposal is not at the generated stage' };
  const problems = await protectedProblems(db, p);
  if (problems.length) return reject(db, id, `protected set: ${problems.join('; ')}`, now, { redteam: { by: 'code', problems } });
  if (!redteam || typeof redteam.attack !== 'function' || !redteam.family) return { id, status: p.status, reason: 'no red-team model: the proposal waits and cannot be adopted' };
  if (redteam.family === p.author_family) return { id, status: p.status, reason: 'red-team model must be of a different family from the author' };
  let res;
  try { res = await redteam.attack({ id, rule_text: p.rule_text, changes: JSON.parse(p.changes || '[]'), commitments: COMMITMENTS, protected_limits: PROTECTED_LIMITS.map(l => l.key) }); }
  catch (e) { return { id, status: p.status, reason: `red-team outage: ${String(e && e.message).slice(0, 120)}` }; }
  const record = { family: redteam.family, harm: Boolean(res && res.harm), case: (res && res.case) || null };
  if (record.harm) return reject(db, id, `red-team found harm: ${record.case || 'no case text'}`, now, { redteam: record });
  await run(db, `UPDATE governance_proposals SET status='redteamed', redteam=? WHERE id=?`, JSON.stringify(record), id);
  return { id, status: 'redteamed' };
}

function applyToRows(rows, changes) {
  const next = rows.map(r => ({ ...r, phrases: r.phrases.map(p => ({ ...p })) }));
  for (const c of changes) {
    const row = next.find(r => r.pattern_key === c.pattern_key);
    if (c.op === 'add_pattern') {
      if (!c.pattern || !c.pattern.pattern_key || next.some(r => r.pattern_key === c.pattern.pattern_key)) throw new Error('add_pattern needs a new pattern_key');
      next.push({ cause_class: 'amendment', detection_heuristic: 'phrase', requires_action: 0, trust_event: null, weight: 0, commitment: null, active: 1, auto_remediation: 'report', pattern: c.pattern.pattern_key,
        ...c.pattern, phrases: (c.phrases || []).map(ph => (typeof ph === 'string' ? { scope: '*', phrase: ph } : ph)) });
      continue;
    }
    if (!row) throw new Error(`unknown pattern ${c.pattern_key}`);
    if (c.op === 'add_phrase') { if (!c.phrase) throw new Error('add_phrase needs a phrase'); row.phrases.push({ scope: c.scope || '*', phrase: c.phrase }); }
    else if (c.op === 'remove_phrase') row.phrases = row.phrases.filter(p => !(p.phrase === c.phrase && p.scope === (c.scope || '*')));
    else if (c.op === 'deactivate_pattern') row.active = 0;
    else if (c.op === 'set_weight') row.weight = c.weight;
    else throw new Error(`unsupported change ${c.op}`);
  }
  for (const r of next) for (const p of r.phrases) if (p.phrase.startsWith('re:')) new RegExp(p.phrase.slice(3)); // a bad expression fails here, not at emission
  return next;
}

function score(rows, scans) {
  const m = { missed_false_stops: 0, false_positives: 0, hits: 0 };
  for (const s of scans) {
    const hit = matchDraft(rows, s.draft, s.scope).length > 0;
    if (hit) m.hits++;
    if (s.label === 1 && !hit) m.missed_false_stops++;
    if (s.label === 0 && hit) m.false_positives++;
  }
  return m;
}

/**
 * E5, US-07-R02: replay. The stored scans of the trailing window are matched again as if the rule had been in force and the
 * result is compared with what the register in force gives. The amendment passes when at least one metric improves and none
 * worsens beyond `tolerance`. Metrics, lower is better: false stops the register misses, and hits on outputs judged not to be
 * false stops. A change this module cannot replay (policy numbers, role text) needs the `evaluate` port, which returns
 * { before, after } metric maps on the same rule. No judged scans and no evaluation means no adoption.
 */
export async function replay(db, id, { now = Date.now(), days = 7, tolerance = 0, evaluate } = {}) {
  const p = await first(db, `SELECT * FROM governance_proposals WHERE id = ?`, id);
  if (!p) throw new Error(`unknown proposal ${id}`);
  if (p.status !== 'redteamed') return { id, status: p.status, reason: 'replay runs only after a red-team that found no harm' };
  const changes = JSON.parse(p.changes || '[]');
  const since = iso(now - days * 86400e3);
  const window = { days, since, ticks: (await first(db, `SELECT COUNT(*) AS n FROM tick_runs WHERE started_at >= ?`, since)).n };
  let before, after;
  if (changes.length && changes.every(c => REGISTER_OPS.includes(c.op))) {
    const scans = await all(db, `SELECT id, draft, scope, label FROM governance_scans WHERE ts >= ? ORDER BY id`, since);
    window.scans = scans.length; window.judged = scans.filter(s => s.label !== null).length;
    if (!window.judged) { await run(db, `UPDATE governance_proposals SET replay=? WHERE id=?`, JSON.stringify({ window, insufficient: true }), id); return { id, status: 'redteamed', reason: 'no judged records in the window to replay against', window }; }
    const rows = await registerRows(db);
    let next;
    try { next = applyToRows(rows, changes); } catch (e) { return reject(db, id, `change cannot be applied: ${e.message}`, now); }
    before = score(rows, scans); after = score(next, scans);
    delete before.hits; delete after.hits;
  } else if (typeof evaluate === 'function') {
    const r = await evaluate({ id, rule_text: p.rule_text, changes, window });
    before = r.before; after = r.after;
  } else {
    await run(db, `UPDATE governance_proposals SET replay=? WHERE id=?`, JSON.stringify({ window, insufficient: true }), id);
    return { id, status: 'redteamed', reason: 'this kind of change needs an evaluate port to be replayed', window };
  }
  const improved = Object.keys(before).filter(k => after[k] < before[k]);
  const worsened = Object.keys(before).filter(k => after[k] > before[k] + tolerance);
  const result = { window, before, after, improved, worsened, tolerance };
  if (!improved.length || worsened.length) {
    return reject(db, id, worsened.length ? `replay worsens ${worsened.join(', ')}` : 'replay improves no metric', now, { replay: result });
  }
  await run(db, `UPDATE governance_proposals SET status='replayed', replay=? WHERE id=?`, JSON.stringify(result), id);
  return { id, status: 'replayed', ...result };
}

const bump = (v) => { const [a, b, c] = String(v).split('.').map(Number); return `${a}.${b}.${c + 1}`; };

/**
 * E6, US-07-R01: adoption by reviewed change. Needs a passed red-team and a passed replay, and a reviewer who is not the
 * author. The register changes are applied, the version increments, a lineage row is written (governance_lineage and the seed
 * doctrine_lineage), and the commitments are verified unchanged against the lineage; a mismatch refuses the adoption.
 */
export async function adopt(db, id, { reviewer, now = Date.now() } = {}) {
  const p = await first(db, `SELECT * FROM governance_proposals WHERE id = ?`, id);
  if (!p) throw new Error(`unknown proposal ${id}`);
  if (p.status !== 'replayed') return { id, adopted: false, reason: `proposal is ${p.status}: adoption needs a passed red-team and a passed replay` };
  if (!reviewer || !String(reviewer).trim()) return { id, adopted: false, reason: 'no reviewer named' };
  if (reviewer === p.author) return { id, adopted: false, reason: 'the reviewer is the author' };
  const last = await first(db, `SELECT * FROM governance_lineage ORDER BY adopted_at DESC, rowid DESC LIMIT 1`);
  const commitments = hash(JSON.stringify(COMMITMENTS));
  if (last && last.commitments_hash !== commitments) return { id, adopted: false, reason: 'commitments differ from the lineage: adoption refused' };
  const changes = JSON.parse(p.changes || '[]').filter(c => REGISTER_OPS.includes(c.op));
  const next = applyToRows(await registerRows(db), changes);
  for (const r of next) {
    await run(db, `INSERT INTO governance_false_stop_register (pattern_key, pattern, cause_class, detection_heuristic, auto_remediation, requires_action, trust_event, weight, commitment, active) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(pattern_key) DO UPDATE SET weight=excluded.weight, active=excluded.active`,
      r.pattern_key, r.pattern, r.cause_class, r.detection_heuristic, r.auto_remediation, r.requires_action ? 1 : 0, r.trust_event ?? null, r.weight ?? 0, r.commitment ?? null, r.active ? 1 : 0);
    await run(db, `DELETE FROM governance_false_stop_phrases WHERE pattern_key = ?`, r.pattern_key);
    for (const ph of r.phrases) await run(db, `INSERT OR IGNORE INTO governance_false_stop_phrases (pattern_key, scope, phrase) VALUES (?,?,?)`, r.pattern_key, ph.scope, ph.phrase);
  }
  const parent = last ? last.version : INITIAL_VERSION, version = bump(parent), nowIso = iso(now);
  await run(db, `INSERT INTO governance_lineage (version, parent_version, proposal_id, register_hash, commitments_hash, adopted_by, adopted_at) VALUES (?,?,?,?,?,?,?)`,
    version, parent, id, registerHash(await registerRows(db)), commitments, reviewer, nowIso);
  await run(db, `INSERT OR IGNORE INTO doctrine_lineage (version, source, adopted_at) VALUES (?,?,?)`, `governance-${version}`, `amendment ${id} reviewed by ${reviewer}`, nowIso);
  await run(db, `UPDATE governance_proposals SET status='adopted', version=?, decided_at=? WHERE id=?`, version, nowIso, id);
  return { id, adopted: true, version, parent, report: `Amendment ${id} adopted as version ${version}; commitments unchanged.` };
}

/** The weekly audit item listing open proposals. Its probe passes when none is older than the window. */
export async function auditItem(db, { now = Date.now(), owner_role = 'operations' } = {}) {
  const open = await all(db, `SELECT id, status FROM governance_proposals WHERE status IN ('${OPEN.join("','")}') ORDER BY created_at, id`);
  if (!open.length) return null;
  const d = new Date(now), monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
  const id = `AMEND-AUDIT-${monday.toISOString().slice(0, 10)}`, nowIso = iso(now);
  await run(db, `INSERT OR IGNORE INTO items (id, title, kind, owner_role, done_check, closing_probe, priority, status, created_at, updated_at) VALUES (?,?,'amendment',?,?,?,30,'ready',?,?)`,
    id, `${open.length} amendment proposal(s) open: ${open.map(o => `${o.id} (${o.status})`).join(', ')}`.slice(0, 300), owner_role, 'every listed proposal is adopted or rejected',
    `SELECT COUNT(*) = 0 FROM governance_proposals WHERE status IN ('${OPEN.join("','")}') AND created_at <= '${nowIso}'`, nowIso, nowIso);
  return id;
}

/** One pass of the loop for a tick: thresholds, generation, red-team, replay, audit. Adoption stays a reviewed change. */
export async function amendStep(db, { now = Date.now(), generate, redteam, evaluate } = {}) {
  const raised = await scanThresholds(db, { now });
  const generated = await generateRules(db, { generate });
  const results = [];
  for (const p of await all(db, `SELECT id FROM governance_proposals WHERE status = 'generated' ORDER BY created_at, id`)) results.push(await redTeam(db, p.id, { redteam, now }));
  for (const p of await all(db, `SELECT id FROM governance_proposals WHERE status = 'redteamed' ORDER BY created_at, id`)) results.push(await replay(db, p.id, { now, evaluate }));
  return { raised, generated, results, audit: await auditItem(db, { now }) };
}
