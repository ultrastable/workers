// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Ignorance mapping: what a system does not know is data, and it feeds the loop. Tenant-agnostic; ports only (store, now, model).
// A registry of gaps (known unknowns, red-team findings, inversions, pre-mortems), miners that find gaps in any subject list, a
// red-team and inversion pass with a deterministic floor and an optional model, and a frontier of questions and leads that keeps the
// solution space expanding instead of shrinking. Method: Quni-Gudzinas, "Universal Ignorance Audit" (doi 10.5281/zenodo.21901984),
// with unknown-unknowns taxonomies, pre-mortems, inversion, assumption mapping, evidence-gap maps and adversarial collaboration.
// Nothing here changes a subject's own claims: findings are challenges shown beside it, never rewrites. Model output is untrusted.
const KEY = 'ignorance:v1';

// The audit instrument: five phases, fifteen questions. Answering "we do not know" is admissible; skipping a question is not.
export const UIA = {
  source: 'Quni-Gudzinas, Universal Ignorance Audit, doi 10.5281/zenodo.21901984',
  phases: ['Surface the structure', 'Stress-test the frame', 'Multiply perspectives', 'Uncover the hidden forces', 'Act'],
  questions: [
    [1, 0, 'What are the hidden assumptions and scaffolds holding this situation or belief up?'],
    [2, 0, 'Where might the map be mistaken for the territory?'],
    [3, 0, 'What is the wobble? Where is the tension, anomaly, or thing that does not fit?'],
    [4, 1, 'What if the opposite were true?'],
    [5, 1, 'What would a world look like in which this was false?'],
    [6, 1, 'If I changed the base, origin, center, or frame, what would remain the same?'],
    [7, 2, 'How would this look to a radically different observer?'],
    [8, 2, 'Who knows something about this that I do not, and what would they say is my biggest blind spot?'],
    [9, 3, 'Who benefits from the current framing? Who or what is silenced, excluded, or harmed?'],
    [10, 3, 'What is the most dangerous question I could ask about this, the one that threatens my certainties?'],
    [11, 3, 'What does this confusion or ignorance feel like, and what does the feeling itself know?'],
    [12, 4, 'What do I already know but am pretending not to know?'],
    [13, 4, 'What can I do with this uncertainty right now, without needing to resolve it?'],
    [14, 4, 'What does the unknown want from me?'],
    [15, 4, 'What question am I not asking that I should be asking, given all of the above?'],
  ].map(([n, phase, text]) => ({ n, phase, phase_name: ['Surface the structure', 'Stress-test the frame', 'Multiply perspectives', 'Uncover the hidden forces', 'Act'][phase], text })),
};

// Three regions of ignorance. Each calls for a different response: known unknowns are worked, unknown unknowns are probed for,
// ignorance about ignorance (how much of the space nobody has looked at) is measured.
export const KINDS = {
  missing_edge: { region: 'known_unknown', response: 'find the missing link, with a source' },
  untested_assumption: { region: 'known_unknown', response: 'design the cheapest test of the assumption' },
  evidence_gap: { region: 'known_unknown', response: 'search for stronger or wider evidence' },
  contradiction: { region: 'known_unknown', response: 'find the effect modifier that explains the disagreement' },
  unexplored_domain: { region: 'known_unknown', response: 'open a new problem area with a first question' },
  estimate_gap: { region: 'known_unknown', response: 'quantify it or state why it cannot be quantified' },
  red_team: { region: 'unknown_unknown', response: 'answer the challenge with evidence or record that it stands' },
  inversion: { region: 'unknown_unknown', response: 'test the opposite or record why it fails' },
  premortem: { region: 'unknown_unknown', response: 'add a check for the failure story or accept the risk' },
  audit_coverage: { region: 'ignorance_about_ignorance', response: 'run the missing passes' },
};

const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => norm(s).slice(0, n);
const slug = s => norm(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const hash = s => { let h = 5381; for (const c of String(s)) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h.toString(36); };
const iso = t => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
export const gapId = (kind, subject, key) => `${kind}:${subject}:${slug(key).slice(0, 24)}-${hash(kind + subject + norm(key).toLowerCase())}`;
const mk = (kind, subject, key, text, extra = {}) => ({ id: gapId(kind, subject, key), kind, region: KINDS[kind].region, subject, text: clip(text, 400), severity: 2, auto: true, ...extra });

// ---- registry --------------------------------------------------------------------------------------------------------------
// A gap leaves the open set only through close() with a disposition and evidence; a closed gap that comes back is reopened and counted.
export function createRegistry({ store, key = KEY, now = () => Date.now() } = {}) {
  let s = null;
  const load = async () => (s = JSON.parse((await store.get(key)) || '{"gaps":{},"challenged":{},"runs":[]}'));
  const save = () => store.put(key, JSON.stringify(s));
  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const sevOrder = (a, b) => b.severity - a.severity || a.id.localeCompare(b.id);
  return {
    async upsert(gaps) {
      await load(); const t = iso(now()); const r = { opened: [], seen: [], reopened: [] };
      for (const g of gaps) {
        if (!g.id || !KINDS[g.kind]) throw new Error('a gap needs a known kind and an id');
        const o = s.gaps[g.id];
        if (!o) { s.gaps[g.id] = { ...g, status: 'open', opened_at: t, last_seen: t, seen: 1, reopened: 0, disposition: null, evidence: null, closed_at: null }; r.opened.push(g.id); }
        else if (o.status === 'closed' && o.disposition === 'resolved') { Object.assign(o, { status: 'open', reopened: o.reopened + 1, last_seen: t, closed_at: null, disposition: null, evidence: null }); r.reopened.push(g.id); }
        else { o.last_seen = t; o.seen++; o.text = g.text || o.text; r.seen.push(g.id); }
      }
      await save(); return r;
    },
    // dispositions: resolved (the gap was filled), accepted (stands, recorded as a known limit), superseded (replaced by another gap)
    async close(id, { disposition, evidence }) {
      await load(); const g = s.gaps[id];
      if (!g) throw new Error('no such gap');
      if (!['resolved', 'accepted', 'superseded'].includes(disposition)) throw new Error('a disposition is resolved, accepted or superseded');
      if (!norm(evidence)) throw new Error('closing a gap needs evidence');
      Object.assign(g, { status: 'closed', disposition, evidence: clip(evidence, 400), closed_at: iso(now()) }); await save(); return clone(g);
    },
    async list({ status, subject, kind, region } = {}) {
      await load(); return clone(Object.values(s.gaps).filter(g => (!status || g.status === status) && (!subject || g.subject === subject) && (!kind || g.kind === kind) && (!region || g.region === region)).sort(sevOrder));
    },
    async markChallenged(subject, passes = ['red_team']) { await load(); s.challenged[subject] = { at: iso(now()), passes }; await save(); },
    async challenged() { await load(); return clone(s.challenged); },
    async recordRun(m) { await load(); s.runs = [...s.runs, { at: iso(now()), ...m }].slice(-100); await save(); },
    async runs() { await load(); return clone(s.runs); },
    // accounting invariant: entered = open + closed with a disposition. A violation means a gap vanished or lost its record.
    async audit() {
      await load(); const all = Object.values(s.gaps), open = all.filter(g => g.status === 'open').length;
      const closed = all.filter(g => g.status === 'closed' && g.disposition && g.evidence).length;
      return { entered: all.length, open, closed, balanced: open + closed === all.length };
    },
    async summary() {
      await load(); const all = Object.values(s.gaps), by = {};
      for (const g of all) { const k = `${g.region}:${g.status}`; by[k] = (by[k] || 0) + 1; }
      const open = all.filter(g => g.status === 'open'), ages = open.map(g => Date.parse(g.opened_at.replace(' ', 'T') + 'Z')).filter(Number.isFinite).map(a => (now() - a) / 864e5).sort((a, b) => a - b);
      return { total: all.length, open: open.length, closed: all.length - open.length, by_region_status: by, by_kind_open: open.reduce((m, g) => ((m[g.kind] = (m[g.kind] || 0) + 1), m), {}), oldest_open_days: ages.length ? Math.round(ages[ages.length - 1] * 10) / 10 : 0, challenged_subjects: Object.keys(s.challenged).length };
    },
  };
}

// ---- miners: each takes { subjects, graph?, config } and returns gaps. Subjects are plain data the tenant maps its entries into:
// { id, type, title, claim, domain, evidence:[{src,finding}], design: 'review'|'trial'|'observational'|'guidance', verdict, works_where, limits, who,
//   assumptions:[{text,tested}], problem_ids, effect:{value,low,high,unit}, bca:{higher_order:[...], counterfactual}, checked:boolean }
const RANK = { review: 4, trial: 3, observational: 2, guidance: 1 };

export function minersFor(extra = []) { return [assumptionMiner, evidenceMiner, contradictionMiner, estimateMiner, unexploredMiner, ...extra]; }

export function assumptionMiner({ subjects }) {
  const out = [];
  for (const s of subjects) {
    const a = s.assumptions || [];
    if (!a.length) out.push(mk('untested_assumption', s.id, 'assumptions-not-stated', `No assumptions are stated for "${s.title}". Every claim rests on some (who it was tested on, who delivers it, what already exists). Which are they, and which were tested?`, { severity: 2, how: 'List the assumptions; mark each tested or untested.' }));
    for (const x of a) if (!x.tested) out.push(mk('untested_assumption', s.id, x.text, `Untested assumption behind "${s.title}": ${x.text}`, { severity: 2, how: 'Design the cheapest test of it.' }));
  }
  return out;
}

export function evidenceMiner({ subjects }) {
  const out = [];
  for (const s of subjects.filter(x => x.type === 'solution' || !x.type)) {
    const ev = s.evidence || [], r = RANK[s.design] || 0;
    if (!ev.length) out.push(mk('evidence_gap', s.id, 'no-evidence', `"${s.title}" cites no evidence.`, { severity: 3 }));
    else if (r < 3) out.push(mk('evidence_gap', s.id, 'weak-design', `The strongest design cited for "${s.title}" is ${s.design || 'unspecified'}, which cannot rule out confounding. Is there a trial or review?`, { severity: 2, how: 'Search for a randomised trial or systematic review.' }));
    if (ev.length === 1) out.push(mk('evidence_gap', s.id, 'single-source', `"${s.title}" rests on one source. Has it been replicated independently?`, { severity: 2, how: 'Search for an independent replication.' }));
    if (s.works_where && /^[^,;]*$/.test(clip(s.works_where, 200)) && !/,| and /.test(s.works_where)) out.push(mk('evidence_gap', s.id, 'single-setting', `"${s.title}" was shown in one setting (${clip(s.works_where, 80)}). Does it hold elsewhere?`, { severity: 2, how: 'Find or run a test in a different setting.' }));
    if (s.checked === false) out.push(mk('evidence_gap', s.id, 'unchecked', `The figures for "${s.title}" have not been checked against the source.`, { severity: 1, how: 'Run the source check.' }));
  }
  return out;
}

// two entries for one problem whose verdicts disagree, a mixed verdict, or an explicit contradicts edge
export function contradictionMiner({ subjects, graph }) {
  const out = [], by = {};
  for (const s of subjects) { if (s.verdict === 'mixed') out.push(mk('contradiction', s.id, 'mixed-verdict', `The studies behind "${s.title}" disagree. What explains it (population, dose, delivery, period)?`, { severity: 3, how: 'Find the effect modifier.' })); for (const p of s.problem_ids || []) (by[p] ||= []).push(s); }
  for (const [p, list] of Object.entries(by)) { const w = list.filter(x => x.verdict === 'works'), m = list.filter(x => x.verdict === 'mixed' || x.verdict === 'does not work'); if (w.length && m.length) out.push(mk('contradiction', p, 'verdicts-differ', `For problem ${p}, ${w.map(x => x.title).join(', ')} work(s) while ${m.map(x => x.title).join(', ')} show(s) mixed or no effect. Is the difference real or an artefact of context?`, { severity: 2, how: 'Compare their settings.' })); }
  return out;
}
export async function graphContradictions({ graph }) {
  if (!graph) return [];
  return (await graph.edges({ rel: 'contradicts' })).map(e => mk('contradiction', e.src, e.dst, `${e.src} and ${e.dst} are recorded as contradicting each other${e.why ? ': ' + e.why : ''}.`, { severity: 3 }));
}
export async function graphGaps({ graph, rules }) {
  if (!graph || !rules || !rules.length) return [];
  return (await graph.questions(rules)).map(q => mk('missing_edge', q.subject, q.rule, q.text, { severity: 1 }));
}

// benefit-cost estimates challenged: no interval, a very wide interval, no higher-order effects, no counterfactual
export function estimateMiner({ subjects }) {
  const out = [];
  for (const s of subjects.filter(x => x.type === 'solution' || !x.type)) {
    const e = s.effect, b = s.bca || {};
    if (!e) { out.push(mk('estimate_gap', s.id, 'no-estimate', `No quantified effect is recorded for "${s.title}" in a common unit.`, { severity: 2, how: 'Extract the effect size with its interval, or say why it cannot be.' })); continue; }
    if (e.low == null || e.high == null) out.push(mk('estimate_gap', s.id, 'no-interval', `The effect estimate for "${s.title}" has no uncertainty interval.`, { severity: 3, how: 'Record the interval from the source.' }));
    else if (e.low > 0 && e.high / e.low > 3) out.push(mk('estimate_gap', s.id, 'wide-interval', `The interval for "${s.title}" spans more than threefold (${e.low} to ${e.high} ${e.unit || ''}). A point estimate would mislead.`, { severity: 2, how: 'Carry the whole interval into any ranking.' }));
    if (!(b.higher_order || []).length) out.push(mk('estimate_gap', s.id, 'higher-order', `Higher-order effects of "${s.title}" are not estimated (multipliers, displacement, unintended consequences).`, { severity: 2, how: 'Estimate or bound each, or record that it was looked for and none was found.' }));
    if (!b.counterfactual) out.push(mk('estimate_gap', s.id, 'counterfactual', `What would have happened without "${s.title}" is not stated for the estimate.`, { severity: 2 }));
  }
  return out;
}

// domains and problems where nobody has looked, or only weak entries exist
export function unexploredMiner({ subjects, config = {} }) {
  const sols = subjects.filter(s => s.type === 'solution' || !s.type), probs = subjects.filter(s => s.type === 'problem');
  const out = [];
  for (const p of probs) {
    const mine = sols.filter(s => (s.problem_ids || []).includes(p.id));
    if (!mine.length) out.push(mk('unexplored_domain', p.id, 'no-solution', `No reviewed solution is listed for "${p.title}". Which interventions have trial or review-level evidence?`, { severity: 3, how: 'Search the literature; list candidates as leads.' }));
    else if (mine.every(s => (RANK[s.design] || 0) < 3)) out.push(mk('unexplored_domain', p.id, 'weak-only', `Every solution listed for "${p.title}" rests on weak designs. What does the strongest evidence say?`, { severity: 2 }));
  }
  const domains = [...new Set(subjects.map(s => s.domain).filter(Boolean))], min = config.min_per_domain ?? 2;
  for (const d of domains) if (sols.filter(s => s.domain === d || (s.domains || []).includes(d)).length < min) out.push(mk('unexplored_domain', 'domain:' + slug(d), 'thin-domain', `The ${d} area has fewer than ${min} solutions. What else works here?`, { severity: 1 }));
  return out;
}

// ---- red team, inversion, pre-mortem ---------------------------------------------------------------------------------------
// The deterministic floor runs with no model. Each finding names the audit question it answers and what would change the conclusion.
export function ruleRedTeam(s) {
  const f = [], T = clip(s.title, 90), claim = String(s.claim || ''), strong = /\b(cut|cuts|reduc|rais|lower|prevent|improv|save|eliminat)/i.test(claim);
  const add = (pass, q, challenge, falsifier, severity = 2) => f.push({ pass, q, challenge: clip(challenge, 360), falsifier: clip(falsifier, 240), severity, source: 'rule' });
  if (strong && (RANK[s.design] || 0) < 3) add('red_team', 2, `The claim for "${T}" is stated as an effect, but the design cited cannot show cause. Is the map being mistaken for the territory?`, 'A randomised trial or review that finds no effect.', 3);
  if (s.verdict === 'mixed') add('red_team', 3, `"${T}" has mixed evidence. The anomaly is the finding: what does it not explain?`, 'A subgroup or setting where the effect reverses.', 3);
  add('red_team', 1, `What does "${T}" quietly assume about who delivers it and what already exists? ${s.who ? 'It names: ' + clip(s.who, 100) + '.' : 'No deliverer is named.'}`, 'A setting without that delivery channel where it still works.', 2);
  if (s.limits) add('red_team', 6, `The stated limit for "${T}" is: ${clip(s.limits, 160)} What is outside that limit that nobody has tested?`, 'Evidence from outside the stated limit.', 2);
  add('red_team', 9, `Who is worse off, excluded or displaced if "${T}" works? Costs and harms that land on others are not in the claim.`, 'A measured harm or displacement effect.', 2);
  add('red_team', 7, `Would the people who must carry out "${T}" describe the cost and effort the same way the evidence does?`, 'Implementers reporting a materially larger burden.', 1);
  add('inversion', 4, `What if the opposite of "${T}" were better: doing nothing, or acting upstream of the problem? Under what conditions would that win?`, 'A head-to-head comparison against the opposite.', 2);
  add('inversion', 5, `Imagine a world where "${T}" is false. What would we see there that we do not see here?`, 'Evidence that those observations exist.', 2);
  add('premortem', 15, `Two years on, the first test of "${T}" failed. The three likeliest reasons: adoption stalled, the effect did not transfer, measurement could not detect it. Which has any check today?`, 'A pilot that fails for one of those reasons.', 2);
  return f;
}

// model(prompt, subject) -> { family, findings: [{pass,q,challenge,falsifier,severity}] }. Untrusted: validated, capped, tagged.
export function sanitizeModel(out, { author_family } = {}) {
  if (!out || typeof out !== 'object' || !Array.isArray(out.findings)) throw new Error('model output has no findings list');
  if (author_family && out.family && out.family === author_family) throw new Error('the red team must come from a different model family than the author');
  return out.findings.slice(0, 8).map(x => ({ pass: ['red_team', 'inversion', 'premortem'].includes(x && x.pass) ? x.pass : 'red_team', q: Number.isInteger(x && x.q) && x.q >= 1 && x.q <= 15 ? x.q : 15, challenge: clip(x && x.challenge, 360), falsifier: clip(x && x.falsifier, 240), severity: [1, 2, 3].includes(x && x.severity) ? x.severity : 2, source: 'model', family: clip(out.family, 40) })).filter(x => x.challenge.length > 20);
}
export const redTeamPrompt = s => `You are an adversarial reviewer. Subject: ${clip(s.title, 160)}. Claim: ${clip(s.claim, 300)}. Evidence: ${(s.evidence || []).map(e => clip(e.src, 100)).join('; ')}. Limits: ${clip(s.limits, 200)}.\nUsing the audit questions (what if the opposite were true, who is harmed, what assumption is hidden, what would a pre-mortem find), return findings that each name a falsifier: what observation would show the claim wrong. Do not restate the claim. Return JSON {family, findings:[{pass,q,challenge,falsifier,severity}]}.`;

export async function redTeam(s, { model, author_family } = {}) {
  const found = ruleRedTeam(s); let model_error = null;
  if (model) { try { found.push(...sanitizeModel(await model({ prompt: redTeamPrompt(s), subject: s }), { author_family })); } catch (e) { model_error = String(e.message || e); } }
  return { findings: found, model_error };
}
export const findingToGap = (subject, f) => mk(f.pass, subject, f.challenge, f.challenge, { severity: f.severity, q: f.q, falsifier: f.falsifier, source: f.source, auto: true, how: f.falsifier ? 'Look for: ' + f.falsifier : undefined });

// ---- the frontier: gaps become questions, problem candidates and solution candidates (leads, never findings) -------------------
export function frontier(gaps) {
  const out = [];
  for (const g of gaps.filter(x => x.status !== 'closed')) {
    const id = 'q:' + g.id;
    if (g.kind === 'unexplored_domain') out.push({ id, type: 'problem_candidate', text: g.text, seed: g.id, priority: g.severity + 1 });
    else if (g.kind === 'inversion') out.push({ id, type: 'solution_candidate', text: 'Test the opposite. ' + g.text, seed: g.id, priority: g.severity });
    else if (g.kind === 'contradiction') out.push({ id, type: 'question', text: g.text, seed: g.id, priority: g.severity + 1 });
    else if (g.kind !== 'audit_coverage') out.push({ id, type: 'question', text: g.text, seed: g.id, priority: g.severity });
  }
  return out.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}
// UIA Q15 seeds the next pass: the subject whose open red-team findings are most severe and least recently challenged goes first.
export function nextTargets(subjects, challenged = {}, gaps = [], n = 3) {
  const sev = {}; for (const g of gaps) if (g.status === 'open') sev[g.subject] = (sev[g.subject] || 0) + g.severity;
  return [...subjects].sort((a, b) => (challenged[a.id] ? Date.parse(challenged[a.id].at.replace(' ', 'T') + 'Z') : 0) - (challenged[b.id] ? Date.parse(challenged[b.id].at.replace(' ', 'T') + 'Z') : 0) || (sev[b.id] || 0) - (sev[a.id] || 0) || a.id.localeCompare(b.id)).slice(0, n);
}
// the full fifteen-question administration for one subject, as prompts a model or a person answers; check() enforces the protocol rules
export const administer = s => UIA.questions.map(q => ({ n: q.n, phase: q.phase_name, prompt: `Target: ${clip(s.title, 120)}. ${q.text} Answer in writing. "We do not know" is allowed; skipping is not.` }));
export function checkAnswers(answers) {
  const problems = [], by = Object.fromEntries((answers || []).map(a => [a.n, a]));
  for (const q of UIA.questions) { const a = by[q.n]; if (!a || !norm(a.answer)) problems.push({ n: q.n, problem: 'unanswered' }); else if (a.inapplicable && !norm(a.stretch)) problems.push({ n: q.n, problem: 'inapplicable without a stretch' }); }
  return { complete: !problems.length, problems, next_seed: (by[15] && norm(by[15].answer)) || null };
}

// ---- the loop step ---------------------------------------------------------------------------------------------------------
// run(): mine, challenge the least-recently-challenged subjects, close gaps that the miners no longer report (with evidence), derive the
// frontier, record metrics. Bounded by `budget` red-team subjects per run. Returns a report the caller stores or publishes.
export async function run({ registry, subjects, graph = null, rules = [], miners = minersFor(), model = null, author_family = null, budget = 3, now = () => Date.now(), config = {} }) {
  const t = iso(now());
  let mined = [];
  for (const m of miners) mined.push(...await m({ subjects, graph, config }));
  mined.push(...await graphContradictions({ graph }), ...await graphGaps({ graph, rules }));
  const challenged0 = await registry.challenged(), before = await registry.list();
  const targets = nextTargets(subjects, challenged0, before, budget), found = []; const errors = [];
  for (const s of targets) {
    const r = await redTeam(s, { model, author_family }); if (r.model_error) errors.push({ subject: s.id, model_error: r.model_error });
    found.push(...r.findings.map(f => findingToGap(s.id, f)));
    await registry.markChallenged(s.id, [...new Set(r.findings.map(f => f.pass))]);
  }
  const unchallenged = subjects.filter(s => !(challenged0[s.id]) && !targets.includes(s));
  if (unchallenged.length) mined.push(mk('audit_coverage', 'coverage', 'unchallenged', `${unchallenged.length} of ${subjects.length} entries have never been red-teamed. The ignorance about the rest is unmeasured.`, { severity: 1, how: 'The loop challenges the stalest entries each run.' }));
  const up = await registry.upsert([...mined, ...found]);
  // auto-detected gaps that the miners no longer report and that are not challenges: the condition is gone, so close with evidence
  const live = new Set(mined.map(g => g.id)), closed = [];
  const MINER_KINDS = new Set(['missing_edge', 'untested_assumption', 'evidence_gap', 'contradiction', 'unexplored_domain', 'estimate_gap', 'audit_coverage']);
  for (const g of await registry.list({ status: 'open' })) if (g.auto && MINER_KINDS.has(g.kind) && !live.has(g.id) && subjects.some(s => s.id === g.subject || g.subject === 'coverage' || g.subject.startsWith('domain:'))) { await registry.close(g.id, { disposition: 'resolved', evidence: `the detector no longer reports this gap (${t})` }); closed.push(g.id); }
  const all = await registry.list(), open = all.filter(g => g.status === 'open'), chall = await registry.challenged();
  const m = { opened: up.opened.length, reopened: up.reopened.length, closed: closed.length, open: open.length, challenged_share: subjects.length ? Object.keys(chall).filter(id => subjects.some(s => s.id === id)).length / subjects.length : 0, subjects: subjects.length, targets: targets.map(s => s.id) };
  await registry.recordRun({ opened: m.opened, closed: m.closed, open: m.open, challenged_share: m.challenged_share });
  const runs = await registry.runs(), recent = runs.slice(-6);
  // The space must not shrink: if four runs in a row find nothing new, the loop has run out of questions, and the answer is a wider
  // pass (more subjects challenged next time, so a model or a person is needed), never silence.
  const stagnant = recent.length >= 4 && recent.slice(-4).every(r => r.opened === 0);
  return { at: t, metrics: { ...m, stagnant, expansion: m.opened - m.closed, audit: await registry.audit() }, frontier: frontier(all).slice(0, 25), errors, widen_next: stagnant ? Math.min(budget * 2, subjects.length) : budget };
}

// the part of the registry safe to show the public: no internals, each gap with what would close it
export async function publicView(registry, subject) {
  const all = await registry.list({ subject }), ch = (await registry.challenged())[subject] || null;
  const shape = g => ({ id: g.id, kind: g.kind, region: g.region, text: g.text, severity: g.severity, how: g.how || KINDS[g.kind].response, falsifier: g.falsifier || null, source: g.source || 'rule', opened_at: g.opened_at, status: g.status, disposition: g.disposition, evidence: g.evidence });
  return { subject, challenged_at: ch && ch.at, open: all.filter(g => g.status === 'open').map(shape), closed: all.filter(g => g.status === 'closed').slice(0, 10).map(shape) };
}
