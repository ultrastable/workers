// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Management lifecycle beyond the gate tables of core/kernel (US-SPEC-15): the delivery-mode rule and tailoring, the
// portfolio cap, the extra conditions of G1, iterations with a required retrospective, deliverables with a closing probe
// another agent runs, the status report on the communication plan's period, and the scope gate.
import { fileURLToPath } from 'node:url';
import { all, first, run, iso, parseIso, compare, assertReadOnly, ensureItem } from '../kernel/util.js';
import { CATALOG, createProject, submitArtifact, advancePhase } from '../kernel/lifecycle.js';

export const MIGRATIONS_DIR = (() => { try { return fileURLToPath(new URL('./migrations/', import.meta.url)); } catch { return null; } })();
export const DEFAULTS = { portfolio_cap: null, initiation_threshold: 0.6, require_readiness: true, status_period_h: 168 };
const cfg = (c) => ({ ...DEFAULTS, ...(c || {}) });
const HOUR = 3600e3;
const filled = (v) => (Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && String(v).trim() !== '');

// ---- US-15-R02: the selection rule. The defaults; an override is a recorded decision. ----
export function selectMode(a = {}) {
  if (a.requirements_stable === true && a.order_fixed_by_dependencies === true && a.external_acceptance_milestone === true)
    return { mode: 'predictive', reason: 'requirements stable, order of work fixed by dependencies, external acceptance milestone' };
  if (a.requirements_unclear === true && a.value_by_increments === true)
    return { mode: 'agile', reason: 'requirements unclear or likely to change, value found by showing working increments' };
  return { mode: 'hybrid', reason: Object.values(a).some(v => v === true || v === false) ? 'neither the predictive nor the agile conditions hold' : 'the person could not say: the default' };
}

// ---- US-15-R03, R13: the mode changes cadence and artifact weight only. Every catalog artifact is required in every mode. ----
const CHARTER = ['objective', 'definition_of_done', 'definition_of_done_probe', 'primary_metric', 'guard_metrics', 'cap', 'authority_limits', 'manager_role'];
const FORMS = {
  'A-INI-1': { all: ['want_verbatim', 'for_whom', 'first_outcomes', 'constraints'] },
  'A-INI-2': { all: CHARTER },                                             // a one-page charter still has every field
  'A-INI-6': { all: ['mode', 'reason'] },
  'A-PLN-4': { all: ['items', 'roadmap'] },
  'A-PLN-5': { predictive: ['milestones', 'dependencies'], agile: ['iteration_days', 'forecast'], hybrid: ['milestones', 'iteration_days'] },
  'A-PLN-6': { all: ['capacity_per_role', 'plus_share', 'spend_cap'] },
  'A-PLN-9': { all: ['what', 'period_h', 'form'] },
};
export function requiredArtifacts(mode) {
  if (!['predictive', 'agile', 'hybrid'].includes(mode)) throw new Error('mode must be predictive, agile or hybrid');
  const out = CATALOG.map(c => ({ ...c, weight: mode === 'predictive' ? 'full' : mode === 'agile' ? 'light' : (c.phase === 'planning' && ['A-PLN-3', 'A-PLN-4', 'A-PLN-5'].includes(c.kind) ? 'light' : 'full'),
    fields: FORMS[c.kind]?.[mode] ?? FORMS[c.kind]?.all ?? [] }));
  if (mode !== 'predictive') out.push({ kind: 'A-EXE-4', phase: 'executing', owner_role: 'project-manager', weight: 'full', fields: ['goal', 'items_taken', 'items_done', 'demo_result', 'retro_outcome'] });
  return out;
}
export const cadence = (mode) => ({ predictive: { review: 'per milestone', iterations: false }, agile: { review: 'per iteration', iterations: true }, hybrid: { review: 'per milestone above, per iteration inside', iterations: true } })[mode];

// The form check behind an artifact's done check: existence is not enough (spec s9, phase theater).
export function checkForm(mode, kind, content) {
  const spec = requiredArtifacts(mode).find(a => a.kind === kind);
  if (!spec) throw new Error(`unknown artifact kind ${kind} for mode ${mode}`);
  const c = content && typeof content === 'object' ? content : {};
  const missing = spec.fields.filter(f => !filled(c[f]));
  const problems = [];
  if (!spec.fields.length && !Object.values(c).some(filled)) problems.push('the artifact has no content');
  if (kind === 'A-INI-2' && filled(c.definition_of_done_probe)) { try { assertReadOnly(c.definition_of_done_probe); } catch (e) { problems.push(`definition of done is not a runnable probe: ${e.message}`); } }
  if (kind === 'A-PLN-4' && Array.isArray(c.roadmap)) {
    if (c.roadmap.length > 5) problems.push('more than five roadmap features');
    c.roadmap.forEach((r, i) => { const m = ['size', 'goal', 'user', 'success_metric', 'closing_probe'].filter(f => !filled(r?.[f])); if (m.length) problems.push(`roadmap feature ${i + 1} lacks ${m.join(', ')}`); });
  }
  return { ok: !missing.length && !problems.length, missing, problems, weight: spec.weight };
}
// Submit an artifact with its content; the done check is the form check for the project's mode.
export async function submitTailored(db, a) {
  const p = await first(db, `SELECT delivery_mode FROM kernel_projects WHERE id = ?`, a.project_id);
  if (!p) throw new Error('unknown project');
  const f = checkForm(p.delivery_mode, a.kind, a.content);
  await submitArtifact(db, { ...a, done_check: `form complete for a ${p.delivery_mode} project (${f.weight})`, done_check_passed: f.ok,
    evidence: f.ok ? 'form check passed' : `form check: missing ${f.missing.join(', ') || 'nothing'}; ${f.problems.join('; ') || 'no other problem'}` });
  await run(db, `INSERT INTO lifecycle_artifact_content (project_id, kind, content, at) VALUES (?,?,?,?)
      ON CONFLICT(project_id, kind) DO UPDATE SET content = excluded.content, at = excluded.at`, a.project_id, a.kind, JSON.stringify(a.content ?? {}), iso(a.now ?? Date.now()));
  if (a.kind === 'A-PLN-9' && f.ok) await setCommunicationPlan(db, a.project_id, Number(a.content.period_h), a.now);
  return f;
}

// ---- US-15-R01, R02, R14: start a project ----
export async function startProject(db, p, { config } = {}) {
  const c = cfg(config), now = p.now ?? Date.now(), rule = selectMode(p.answers);
  let mode = rule.mode, reason = rule.reason, overridden = 0;
  if (p.override) {
    if (!['predictive', 'agile', 'hybrid'].includes(p.override.mode)) throw new Error('override mode must be predictive, agile or hybrid');
    if (!filled(p.override.reason) || !filled(p.override.decided_by)) throw new Error('an override of the selection rule is a recorded decision: reason and decided_by (US-15-R02)');
    mode = p.override.mode; overridden = mode !== rule.mode ? 1 : 0; reason = `${p.override.reason} (rule gave ${rule.mode}: ${rule.reason})`;
  }
  const need = p.capacity ?? 0;
  if (!(typeof need === 'number' && need >= 0)) throw new Error('capacity must be a number');
  if (c.portfolio_cap !== null) { // US-15-R14: not started when it would take the total above the cap
    const used = (await first(db, `SELECT COALESCE(SUM(k.capacity), 0) AS n FROM lifecycle_capacity k JOIN kernel_projects kp ON kp.id = k.project_id WHERE kp.current_phase <> 'closed'`)).n;
    if (used + need > c.portfolio_cap) {
      const item = `CAPACITY-${p.id}`;
      await ensureItem(db, { id: item, title: `Project ${p.id} needs ${need} of capacity; ${used} of ${c.portfolio_cap} is in use`, kind: 'work', owner_role: 'portfolio-manager', priority: 20,
        done_check: 'capacity is freed by closing or re-planning a project, or the cap is raised by a recorded change', closing_probe: `project ${p.id} started` });
      return { started: false, reason: `portfolio cap: ${used} + ${need} > ${c.portfolio_cap}`, item_id: item };
    }
  }
  await createProject(db, { id: p.id, name: p.name, program_id: p.program_id, delivery_mode: mode, mode_reason: reason, now });
  await run(db, `INSERT INTO lifecycle_mode_decisions (project_id, mode, rule_mode, reason, overridden, decided_by, at) VALUES (?,?,?,?,?,?,?)`, p.id, mode, rule.mode, reason, overridden, p.override?.decided_by ?? 'selection rule', iso(now));
  await run(db, `INSERT INTO lifecycle_capacity (project_id, capacity, at) VALUES (?,?,?)`, p.id, need, iso(now));
  return { started: true, mode, reason, overridden: Boolean(overridden) };
}

// ---- Gate extras, then the kernel gate (US-15-R04) ----
// G1: the charter's definition of done is a probe another agent can run, and the readiness score (US-SPEC-16, a port)
//     is at least the initiation threshold. A score that cannot be read is not a pass.
// G3: every deliverable's closing probe was passed by an agent other than its producer; no iteration lacks its retrospective.
export async function advance(db, projectId, to, { readiness = null, config, now = Date.now() } = {}) {
  const c = cfg(config), reasons = [];
  if (to === 'planning') {
    const ch = await first(db, `SELECT content FROM lifecycle_artifact_content WHERE project_id = ? AND kind = 'A-INI-2'`, projectId);
    let probe = null; try { probe = JSON.parse(ch?.content || '{}').definition_of_done_probe ?? null; } catch { probe = null; }
    try { assertReadOnly(probe); } catch { reasons.push(['charter-probe', 'project-manager', "the charter's definition of done is not a probe a different agent can run"]); }
    if (c.require_readiness) {
      let score = null; try { const r = readiness ? await readiness(projectId) : null; score = typeof r === 'number' ? r : (r?.score ?? null); } catch { score = null; }
      if (score === null) reasons.push(['readiness', 'project-manager', 'the readiness score could not be read']);
      else if (score < c.initiation_threshold) reasons.push(['readiness', 'project-manager', `readiness ${score.toFixed(2)} is under the initiation threshold ${c.initiation_threshold}`]);
    }
  }
  if (to === 'closed') {
    const d = await all(db, `SELECT id FROM lifecycle_deliverables WHERE project_id = ? AND (probe_passed IS NULL OR probe_passed = 0)`, projectId);
    if (d.length) reasons.push(['deliverable-probes', 'reviewer', `${d.length} deliverable(s) have no passed closing probe: ${d.map(x => x.id).join(', ')}`]);
    const it = await all(db, `SELECT n FROM lifecycle_iterations WHERE project_id = ? AND retro_at IS NULL`, projectId);
    if (it.length) reasons.push(['retrospective', 'project-manager', `iteration(s) ${it.map(x => x.n).join(', ')} have no retrospective`]);
  }
  if (reasons.length) { // unmet conditions are items for their owners, not errors (T15-1)
    const filed = [];
    for (const [slug, owner, text] of reasons) { const id = `GATE-${projectId}-${to}-${slug}`; if (await ensureItem(db, { id, title: text, owner_role: owner, project: projectId, done_check: text, closing_probe: `project ${projectId} enters ${to}`, priority: 20 })) filed.push(id); }
    return { ok: false, reasons: reasons.map(r => r[2]), filed };
  }
  return advancePhase(db, projectId, to, { now });
}

// ---- US-15-R08: deliverables ----
export async function recordDeliverable(db, d) {
  for (const f of ['id', 'project_id', 'path_or_ref', 'produced_by']) if (!filled(d[f])) throw new Error(`deliverable requires ${f}`);
  if (!filled(d.closing_probe)) throw new Error('every deliverable has a closing probe a different agent can run (US-15-R08)');
  assertReadOnly(d.closing_probe);
  if (/^\s*(chat|conversation)\b/i.test(d.path_or_ref)) throw new Error('a deliverable is a file or record, not chat');
  await run(db, `INSERT INTO lifecycle_deliverables (id, project_id, path_or_ref, closing_probe, produced_by, at) VALUES (?,?,?,?,?,?)`, d.id, d.project_id, d.path_or_ref, d.closing_probe, d.produced_by, iso(d.now ?? Date.now()));
}
export async function runDeliverableProbe(db, id, { runner, now = Date.now() }) {
  const d = await first(db, `SELECT * FROM lifecycle_deliverables WHERE id = ?`, id);
  if (!d) throw new Error('unknown deliverable');
  if (!runner || runner === d.produced_by) throw new Error('the closing probe is run by a different agent than the producer');
  let passed = 0, evidence;
  try { const r = await first(db, assertReadOnly(d.closing_probe)); const v = r ? (r.value ?? Object.values(r)[0]) : null; passed = Number(v) >= 1 ? 1 : 0; evidence = `value ${v ?? 'none'}`; }
  catch (e) { evidence = `probe error: ${e.message}`; }
  await run(db, `UPDATE lifecycle_deliverables SET probe_run_by = ?, probe_passed = ?, probe_evidence = ?, probe_at = ? WHERE id = ?`, runner, passed, evidence, iso(now), id);
  return { id, passed: Boolean(passed), evidence };
}

// ---- US-15-R09, T15-5: iterations ----
export async function startIteration(db, { project_id, goal, items = [], now = Date.now() }) {
  const p = await first(db, `SELECT delivery_mode, current_phase FROM kernel_projects WHERE id = ?`, project_id);
  if (!p) throw new Error('unknown project');
  if (p.delivery_mode === 'predictive') throw new Error('a predictive project has milestones, not iterations');
  if (p.current_phase !== 'executing') throw new Error(`iterations run in executing; the project is in ${p.current_phase}`);
  if (!filled(goal)) throw new Error('an iteration has a goal');
  const prev = await first(db, `SELECT * FROM lifecycle_iterations WHERE project_id = ? ORDER BY n DESC LIMIT 1`, project_id);
  if (prev && !prev.retro_at) { // the next iteration is blocked; what is missing is filed
    const what = prev.ended_at ? 'has no retrospective' : 'has not ended';
    const id = `RETRO-${project_id}-${prev.n}`;
    await ensureItem(db, { id, title: `Iteration ${prev.n} of ${project_id} ${what}; the next iteration is blocked`, kind: 'work', owner_role: 'project-manager', project: project_id, priority: 10,
      done_check: `iteration ${prev.n} is ended and its retrospective is recorded with at least one improvement`, closing_probe: `iteration ${prev.n + 1} of ${project_id} started` });
    return { ok: false, reason: `iteration ${prev.n} ${what}`, item_id: id };
  }
  const n = (prev?.n ?? 0) + 1;
  const r = await run(db, `INSERT INTO lifecycle_iterations (project_id, n, goal, items_taken, started_at) VALUES (?,?,?,?,?)`, project_id, n, goal, JSON.stringify(items), iso(now));
  return { ok: true, id: r.meta.last_row_id, n };
}
export async function endIteration(db, id, { items_done = [], demo_result, now = Date.now() }) {
  const it = await first(db, `SELECT * FROM lifecycle_iterations WHERE id = ?`, id);
  if (!it || it.ended_at) throw new Error('no open iteration');
  if (!filled(demo_result)) throw new Error('an iteration ends with the result of its demonstration');
  const stray = items_done.filter(i => !JSON.parse(it.items_taken).includes(i));
  if (stray.length) throw new Error(`not taken in this iteration: ${stray.join(', ')}`);
  await run(db, `UPDATE lifecycle_iterations SET items_done = ?, demo_result = ?, ended_at = ? WHERE id = ?`, JSON.stringify(items_done), demo_result, iso(now), id);
}
// The retrospective's improvements enter the plus queue; the improvement is not optional.
export async function recordRetrospective(db, id, { outcome, improvements = [], now = Date.now() }) {
  const it = await first(db, `SELECT * FROM lifecycle_iterations WHERE id = ?`, id);
  if (!it) throw new Error('unknown iteration');
  if (!it.ended_at) throw new Error('the iteration has not ended');
  if (it.retro_at) throw new Error('the retrospective is already recorded');
  const imps = improvements.map(s => String(s || '').trim()).filter(Boolean);
  if (!filled(outcome) || !imps.length) throw new Error('a retrospective records its outcome and at least one improvement (US-15-R09)');
  const pj = await first(db, `SELECT program_id FROM kernel_projects WHERE id = ?`, it.project_id);
  const items = [];
  for (const [i, text] of imps.entries()) {
    const item = `RETROPLUS-${it.project_id}-${it.n}-${i + 1}`;
    await ensureItem(db, { id: item, title: `From the iteration ${it.n} retrospective: ${text}`, kind: 'plus', owner_role: 'product-manager', project: pj?.program_id ?? it.project_id, priority: 30,
      done_check: 'the improvement is applied and its effect measured', closing_probe: `the improvement is visible in iteration ${it.n + 1}` });
    items.push(item);
  }
  await run(db, `UPDATE lifecycle_iterations SET retro_outcome = ?, retro_items = ?, retro_at = ? WHERE id = ?`, outcome, JSON.stringify(items), iso(now), id);
  return { items };
}

// ---- US-15-R10: the status report, with predicted versus actual ----
export async function setCommunicationPlan(db, projectId, period_h, now = Date.now()) {
  if (!(typeof period_h === 'number' && period_h > 0)) throw new Error('the communication plan states a period in hours');
  await run(db, `INSERT INTO lifecycle_comm_plans (project_id, period_h, at) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET period_h = excluded.period_h, at = excluded.at`, projectId, period_h, iso(now));
}
const SCOPE_SQL = `(i.project = ? OR i.project = ?)`;
export async function produceStatusReport(db, { project_id, now = Date.now() }) {
  const p = await first(db, `SELECT * FROM kernel_projects WHERE id = ?`, project_id);
  if (!p) throw new Error('unknown project');
  const last = (await first(db, `SELECT MAX(at) AS at FROM lifecycle_status_reports WHERE project_id = ?`, project_id))?.at || p.created_at;
  const prog = p.program_id ?? project_id;
  const count = async (where, ...a) => (await first(db, `SELECT COUNT(*) AS n FROM items i WHERE ${SCOPE_SQL} AND ${where}`, project_id, prog, ...a)).n;
  const doneN = await count(`i.status = 'done' AND i.updated_at > ?`, last);
  const openN = await count(`i.status NOT IN ('done','superseded','cancelled')`);
  const blockedN = await count(`i.status = 'blocked'`);
  const next = await all(db, `SELECT i.id FROM items i WHERE ${SCOPE_SQL} AND i.status IN ('ready','claimed') ORDER BY i.priority, i.created_at LIMIT 3`, project_id, prog);
  const decisions = await all(db, `SELECT id, decision, prediction, metric_id, op, target, observed, status, outcome, due_at FROM kernel_decisions WHERE program_id IN (?, ?) ORDER BY decided_at`, project_id, prog);
  const crs = (await first(db, `SELECT COUNT(*) AS n FROM change_requests WHERE project_id = ? AND decision IS NULL`, project_id)).n;
  // metric values against targets, judged on this clock
  const metrics = [];
  for (const m of await all(db, `SELECT * FROM kernel_metrics WHERE program_id IN (?, ?) ORDER BY id`, project_id, prog)) {
    const r = await first(db, `SELECT value, read_at FROM kernel_metric_readings WHERE metric_id = ? ORDER BY id DESC LIMIT 1`, m.id);
    const fresh = r && r.value !== null && (now - parseIso(r.read_at)) / HOUR <= m.max_age_h;
    metrics.push({ id: m.id, value: fresh ? r.value : null, op: m.op, target: m.target, state: !fresh ? 'unmeasured' : compare(m.op, r.value, m.target) ? 'on_target' : 'breach' });
  }
  // A-MON-2: predicted versus actual for each prediction; an open one past its due time is late
  const variance = decisions.map(d => ({ id: d.id, predicted: d.prediction, actual: d.observed ?? null,
    verdict: d.status === 'open' ? (parseIso(d.due_at) <= now ? 'late: not scored' : 'pending') : (d.outcome || d.status) }));
  const decidedNew = decisions.filter(d => d.status !== 'open').length;
  const text = [
    `Happened: ${doneN} item(s) done since ${last}; phase ${p.current_phase} (${p.delivery_mode}).`,
    `Decided: ${decisions.length} decision(s) on record, ${decidedNew} scored; ${variance.filter(v => /^(kept|matched)/.test(v.verdict)).length} as predicted, ${variance.filter(v => /^(missed|reverted|blocked|unmeasured|late)/.test(v.verdict)).length} not.`,
    `Next: ${next.length ? next.map(n => n.id).join(', ') : 'nothing is ready'}.`,
    `Open: ${openN} item(s), ${blockedN} blocked, ${crs} change request(s) pending; metrics ${metrics.map(m => `${m.id}=${m.value ?? 'unmeasured'} (${m.op} ${m.target}: ${m.state})`).join(', ') || 'none registered'}.`,
  ].join('\n');
  const r = await run(db, `INSERT INTO lifecycle_status_reports (project_id, text, metrics, variance, at) VALUES (?,?,?,?,?)`, project_id, text, JSON.stringify(metrics), JSON.stringify(variance), iso(now));
  return { id: r.meta.last_row_id, text, metrics, variance };
}
// Projects whose last report is older than their communication plan's period (default: weekly) get one now.
export async function refreshStatusReports(db, { now = Date.now(), config } = {}) {
  const c = cfg(config), out = [];
  for (const p of await all(db, `SELECT kp.id, kp.created_at, cp.period_h, (SELECT MAX(at) FROM lifecycle_status_reports r WHERE r.project_id = kp.id) AS last
      FROM kernel_projects kp LEFT JOIN lifecycle_comm_plans cp ON cp.project_id = kp.id WHERE kp.current_phase <> 'closed' ORDER BY kp.id`)) {
    if ((now - parseIso(p.last || p.created_at)) / HOUR >= (p.period_h ?? c.status_period_h)) out.push((await produceStatusReport(db, { project_id: p.id, now })).id);
  }
  return out;
}

// ---- US-15-R12, T15-4: the scope gate ----
// The default rules restate the out-of-scope table of SCOPE.md. config.scope_rules replaces them.
export const SCOPE_RULES = [
  { rule: 'business-plan', pack: 'business-plan', why: 'a business plan, financial model, pitch or funding application is a different product', re: /\b(business plan|financial model|pitch deck|investor pitch|funding application|grant application)\b/i },
  { rule: 'legal-filing', pack: 'legal', why: 'filing a legal instrument needs an identity-bound signature', re: /\b(file|register)\b.{0,40}\b(trademark|patent|incorporation|legal (document|instrument))\b|\bpatent application\b/i },
  { rule: 'advice', pack: 'advice', why: 'legal, tax, investment and medical advice are not what the system is designed or tested for', re: /\b(legal|tax|investment|medical) advice\b/i },
  { rule: 'marketing', pack: 'outreach', why: 'outbound contact with other people needs consent and a policy of its own', re: /\b(marketing campaign|run (the |our |my )?(marketing|sales|outreach)|cold (email|outreach)|social media (account|campaign|posts?))\b/i },
  { rule: 'money', pack: 'payments', why: 'hiring, paying, contracting and moving money are irreversible and identity-bound', re: /\b(hire (a|an|the)\b|pay (the|an?|our)\b.{0,30}\b(invoice|contractor|vendor)|wire (the )?money|sign (the|a) contract)\b/i },
  { rule: 'research', pack: 'research', why: 'research and paper writing for the person is a separate product', re: /\b(write (a|the|my) (research )?paper|literature review|do (the |my )?research)\b/i },
];
export function classifyScope(text, { rules = SCOPE_RULES } = {}) {
  const r = rules.find(x => x.re.test(String(text || '')));
  return r ? { in_scope: false, rule: r.rule, pack: r.pack, why: r.why } : { in_scope: true };
}
// Enabling a pack is a recorded decision with a revert path (SCOPE.md change control). It releases what the gate held.
export async function decidePack(db, { pack, enabled, reason, revert_path, decided_by, now = Date.now() }) {
  for (const [k, v] of Object.entries({ pack, reason, revert_path, decided_by })) if (!filled(v)) throw new Error(`a pack decision records ${k}`);
  await run(db, `INSERT INTO lifecycle_scope_decisions (pack, enabled, reason, revert_path, decided_by, at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(pack) DO UPDATE SET enabled=excluded.enabled, reason=excluded.reason, revert_path=excluded.revert_path, decided_by=excluded.decided_by, at=excluded.at`, pack, enabled ? 1 : 0, reason, revert_path, decided_by, iso(now));
  const released = [];
  if (enabled) for (const h of await all(db, `SELECT * FROM lifecycle_scope_gate WHERE pack = ? AND status = 'held' ORDER BY id`, pack)) {
    const item = `SCOPED-${h.id}`;
    await ensureItem(db, { id: item, title: h.request, kind: 'work', owner_role: 'project-manager', project: h.project_id, priority: 40, done_check: `delivered through pack ${pack}`, closing_probe: `pack ${pack} run recorded for this request` });
    await run(db, `UPDATE lifecycle_scope_gate SET status = 'released', item_id = ?, released_at = ? WHERE id = ?`, item, iso(now), h.id);
    released.push(item);
  }
  return { released };
}
// Intake: an in-scope request becomes an item; an out-of-scope one becomes a scope-gate entry with its answer and no item.
// request.pack lets an upstream classifier name the pack directly.
export async function requestWork(db, q, { config } = {}) {
  if (!filled(q.id) || !filled(q.text)) throw new Error('a request has an id and text');
  const now = q.now ?? Date.now();
  const s = q.pack ? { in_scope: false, rule: 'tagged', pack: q.pack, why: `it is the work of the ${q.pack} pack` } : classifyScope(q.text, { rules: cfg(config).scope_rules || SCOPE_RULES });
  const enabled = !s.in_scope && (await first(db, `SELECT enabled FROM lifecycle_scope_decisions WHERE pack = ?`, s.pack))?.enabled === 1;
  if (s.in_scope || enabled) {
    await ensureItem(db, { id: q.id, title: q.text, kind: 'work', owner_role: q.owner_role || 'project-manager', project: q.project_id, priority: q.priority ?? 50, done_check: q.done_check || 'the request is delivered and verified', closing_probe: q.closing_probe });
    return { accepted: true, item_id: q.id, pack: enabled ? s.pack : null };
  }
  const answer = `This is outside what Ultrastable does by default: ${s.why}. The ${s.pack} pack would cover it; it is off until a recorded decision turns it on.`;
  const r = await run(db, `INSERT INTO lifecycle_scope_gate (request, requested_by, project_id, rule, pack, answer, at) VALUES (?,?,?,?,?,?,?)`, q.text, q.requested_by ?? null, q.project_id ?? null, s.rule, s.pack, answer, iso(now));
  return { accepted: false, scope_gate_id: r.meta.last_row_id, pack: s.pack, answer };
}

// Tick step for the composition root (spec s7, M&C): refresh the status reports that are due.
export function lifecycleStep() {
  return { name: 'lifecycle_gates', run: async (db, ctx) => {
    if (ctx.config?.lifecycle?.enabled === false) { ctx.notes?.push('lifecycle: off'); return; }
    const n = await refreshStatusReports(db, { now: typeof ctx.now === 'number' ? ctx.now : Date.now(), config: ctx.config?.lifecycle });
    ctx.notes?.push(`lifecycle: ${n.length} status report(s)`);
  } };
}
