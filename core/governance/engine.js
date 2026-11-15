// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Recognition engine and pre-emission filter (US-SPEC-07 section 3.1). A draft is matched against the signature register;
// a hit is either excluded (refusal with reason, interrupt-eligible stop, another agent's live claim) and reported as a
// disposition, or it is a false stop: the abandoned path is executed and verified before the rewritten statement is emitted,
// or the output reports the dispatch or the open item (US-07-R05, R06). Every hit is recorded (US-07-R07).
// Ports: db, now, execute(action, ctx), dispatch(action, ctx), deduct(deduction), classifier(maskedText, patterns), revise(req).
import { all, first, run, iso, registerRows } from './register.js';

/** Replace fenced code, inline code, double-quoted text and quoted lines with spaces of the same length. Offsets are kept. */
export function mask(text) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return String(text ?? '')
    .replace(/```[\s\S]*?(```|$)/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/^[ \t]*>.*$/gm, blank)
    .replace(/"[^"\n]*"|“[^”\n]*”/g, blank);
}

function phraseMatch(phrase, masked) {
  if (phrase.startsWith('re:')) {
    const m = new RegExp(phrase.slice(3), 'i').exec(masked);
    return m ? { index: m.index, length: Math.max(1, m[0].length) } : null;
  }
  const i = masked.toLowerCase().indexOf(phrase.toLowerCase());
  return i < 0 ? null : { index: i, length: phrase.length };
}

/**
 * Match a draft against register rows. Returns one hit per pattern: { pattern_key, index, length, excerpt, row }.
 * `classified` are hits a classifier port returned ([{ pattern_key, score?, excerpt? }]); they count for active rows only.
 */
export function matchDraft(rows, draft, scope = 'report', classified = [], threshold = 0.5) {
  const text = String(draft ?? ''), masked = mask(text);
  const hits = [];
  for (const row of rows) {
    if (!row.active) continue;
    let hit = null;
    for (const p of row.phrases) {
      if (p.scope !== '*' && p.scope !== scope) continue;
      const m = phraseMatch(p.phrase, masked);
      if (m && (!hit || m.index < hit.index)) hit = m;
    }
    if (!hit) {
      const c = classified.find(x => x.pattern_key === row.pattern_key && (x.score ?? 1) >= threshold);
      if (c) hit = { index: -1, length: 0, by: 'classifier', excerpt: c.excerpt };
    }
    if (hit) {
      hits.push({ pattern_key: row.pattern_key, index: hit.index, length: hit.length, by: hit.by || 'phrase', row,
        excerpt: (hit.excerpt ?? text.slice(Math.max(0, hit.index - 60), hit.index + hit.length + 60)).replace(/\s+/g, ' ').trim().slice(0, 200) });
    }
  }
  return hits;
}

// Sentences with their offsets in the draft; a sentence ends at . ! ? followed by whitespace, or at a line break.
function sentences(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const end = ch === '\n' || ((ch === '.' || ch === '!' || ch === '?') && (i + 1 === text.length || /\s/.test(text[i + 1])));
    if (end) { out.push({ start, end: i + 1, text: text.slice(start, i + 1) }); start = i + 1; }
  }
  if (start < text.length) out.push({ start, end: text.length, text: text.slice(start) });
  return out;
}

async function exclusion(db, ctx) {
  if (ctx.refusal && ctx.refusal.check && ctx.refusal.reason) {
    return { reason: `refusal by ${ctx.refusal.check}: ${ctx.refusal.reason}`, owner: ctx.owner || ctx.refusal.check, probe: ctx.closing_probe || `the ${ctx.refusal.check} check accepts the corrected action` };
  }
  if (ctx.interrupt_eligible) return { reason: 'interrupt-eligible step', owner: ctx.owner || 'principal', probe: ctx.closing_probe || (ctx.gate_card ? `gate card ${ctx.gate_card} closes` : 'the gate card closes') };
  if (ctx.item_id) {
    const c = await first(db, `SELECT agent FROM claims WHERE item_id = ?`, ctx.item_id);
    if (c && c.agent !== ctx.agent) return { reason: `live claim of ${c.agent} on ${ctx.item_id}`, owner: c.agent, probe: ctx.closing_probe || `item ${ctx.item_id} is done or its claim is released` };
  }
  return null;
}

async function recordHits(db, hits, s, nowIso, ex) {
  const ids = [];
  for (const h of hits) {
    const r = await run(db, `INSERT INTO governance_false_stop_hits (ts, pattern_key, source, source_ref, excerpt, excluded, exclusion_reason, scan_id) VALUES (?,?,?,?,?,?,?,?)`,
      nowIso, h.pattern_key, s.source, s.source_ref ?? null, h.excerpt, ex ? 1 : 0, ex ? ex.reason.slice(0, 200) : null, s.scan_id);
    ids.push(r.meta.last_row_id);
  }
  return ids;
}

async function deduct(db, ports, ctx, key, event, weight, hitId, nowIso) {
  if (!ctx.surface || !ctx.action_class || !event || !weight) return null;
  const d = { surface: ctx.surface, action_class: ctx.action_class, executor: ctx.agent || '', event, weight, ref: `recognition:${key}:${hitId ?? ''}` };
  await run(db, `INSERT INTO governance_deductions (ts, surface, action_class, executor, pattern_key, event, weight, hit_id) VALUES (?,?,?,?,?,?,?,?)`,
    nowIso, d.surface, d.action_class, d.executor || null, key, event, weight, hitId ?? null);
  if (ports.deduct) await ports.deduct(d);
  return d;
}

async function storeScan(db, s, nowIso) {
  const tick = await first(db, `SELECT MAX(id) AS id FROM tick_runs`);
  const r = await run(db, `INSERT INTO governance_scans (ts, source, source_ref, scope, tick_id, draft) VALUES (?,?,?,?,?,?)`,
    nowIso, s.source, s.source_ref ?? null, s.scope, tick ? tick.id : null, String(s.draft).slice(0, 4000));
  return r.meta.last_row_id;
}

// A classifier outage leaves phrase matching in force; the error is returned on the result, not dropped.
async function classify(ports, draft, rows, note) {
  if (!ports.classifier) return [];
  try { return (await ports.classifier(mask(draft), rows.filter(r => r.active).map(r => ({ pattern_key: r.pattern_key, pattern: r.pattern })))) || []; }
  catch (e) { if (note) note.classifier_error = String(e && e.message).slice(0, 160); return []; }
}

/**
 * recognize_and_redirect. input = { draft, source, source_ref?, scope?, ctx? }.
 * ctx = { surface, action_class, agent, item_id, interrupt_eligible, refusal: { check, reason }, action, surfaces: [{ name, test }], owner, closing_probe }.
 * Returns { emitted, hits, excluded, executed?, dispatched?, item?, deductions }.
 */
export async function recognize(db, input, ports = {}) {
  const now = ports.now ?? Date.now(), nowIso = iso(now);
  const s = { draft: String(input.draft ?? ''), source: input.source || 'unknown', source_ref: input.source_ref, scope: input.scope || 'report' };
  const ctx = input.ctx || {};
  const rows = input.rows || await registerRows(db);
  s.scan_id = await storeScan(db, s, nowIso);
  const note = {};
  const hits = matchDraft(rows, s.draft, s.scope, await classify(ports, s.draft, rows, note), ports.classifier_threshold);
  const brief = hits.map(h => ({ pattern_key: h.pattern_key, excerpt: h.excerpt, redirect: h.row.auto_remediation }));
  if (!hits.length) return { emitted: s.draft, hits: [], excluded: false, deductions: [], scan_id: s.scan_id, ...note };

  const ex = await exclusion(db, ctx);
  if (ex) { // reported as exactly what it is, with its owner and closing probe
    await recordHits(db, hits, s, nowIso, ex);
    return { emitted: `${s.draft.trimEnd()}\nDisposition: ${ex.reason}; owner ${ex.owner}; closing probe: ${ex.probe}.`, hits: brief, excluded: true, exclusion_reason: ex.reason, deductions: [], scan_id: s.scan_id };
  }

  const ids = await recordHits(db, hits, s, nowIso, null);
  const deductions = [];
  for (let i = 0; i < hits.length; i++) {
    const d = await deduct(db, ports, ctx, hits[i].pattern_key, hits[i].row.trust_event, hits[i].row.weight, ids[i], nowIso);
    if (d) deductions.push(d);
  }
  // Drop every sentence that carries a hit; what replaces it is stated only from a result that was read back.
  const kept = sentences(s.draft).filter(sen => !hits.some(h => h.index >= 0 ? h.index >= sen.start && h.index < sen.end : false)).map(sen => sen.text.trim()).filter(Boolean);
  const lines = [];
  const out = { hits: brief, excluded: false, deductions, scan_id: s.scan_id, ...note };

  let surfaceOk = null;
  if (hits.some(h => h.pattern_key === 'blocker_no_surfaces')) {
    const tested = [];
    for (const sf of ctx.surfaces || []) {
      let ok = false, detail = '';
      try { const r = await sf.test(); ok = Boolean(r && r.ok); detail = (r && r.detail) || ''; } catch (e) { detail = String(e && e.message).slice(0, 100); }
      tested.push({ name: sf.name, ok, detail });
      if (ok && !surfaceOk) surfaceOk = sf.name;
    }
    out.surfaces = tested;
    if (tested.length) lines.push(`Surfaces tested: ${tested.map(t => `${t.name} ${t.ok ? 'works' : `failed${t.detail ? ` (${t.detail})` : ''}`}`).join('; ')}.`);
    else { // a blocker reported with no surface coverage costs trust again
      const d = await deduct(db, ports, ctx, 'blocker_no_surfaces', 'handoff_of_executable_step', -0.10, null, nowIso);
      if (d) deductions.push(d);
      lines.push('No surface was tested for this blocker.');
    }
  }

  if (hits.some(h => h.row.requires_action)) {
    const action = ctx.action ? { ...ctx.action, surface: surfaceOk || ctx.action.surface } : null;
    const blocked = out.surfaces && out.surfaces.length && !surfaceOk;
    let res = null;
    if (action && ports.execute && !blocked) {
      try { res = await ports.execute(action, ctx); } catch (e) { res = { verified: false, evidence: `execution failed: ${String(e && e.message).slice(0, 160)}` }; }
    }
    if (res && res.verified && res.statement) {
      out.executed = { ref: res.ref ?? null };
      lines.push(res.ref && !res.statement.includes(String(res.ref)) ? `${res.statement.replace(/[.\s]+$/, '')} (${res.ref}).` : res.statement);
    } else {
      let disp = null, dispErr = '';
      if (action && ports.dispatch) { try { disp = await ports.dispatch(action, ctx); } catch (e) { dispErr = `; dispatch failed: ${String(e && e.message).slice(0, 100)}`; } }
      if (disp && disp.dispatched) {
        out.dispatched = { to: disp.to ?? null, ref: disp.ref ?? null };
        lines.push(`Dispatched to ${disp.to || 'the roster'}${disp.ref ? ` as ${disp.ref}` : ''}: ${action.summary || action.kind || 'the abandoned step'}.`);
      } else {
        const item = `FALSESTOP-${s.scan_id}`;
        const why = ((res && res.evidence) || (blocked ? 'every tested surface failed' : action ? 'no executor could take it' : 'the abandoned step was not named')) + dispErr;
        await run(db, `INSERT OR IGNORE INTO items (id, title, kind, owner_role, done_check, priority, status, surface, action_class, created_at, updated_at) VALUES (?,?,'fix',?,?,5,'ready',?,?,?,?)`,
          item, `Abandoned step from ${s.source}: ${(action && (action.summary || action.kind)) || hits[0].excerpt}`.slice(0, 300), ports.owner_role || 'operations',
          `the step is executed and verified: ${(action && (action.summary || action.kind)) || hits[0].row.auto_remediation}`.slice(0, 300), ctx.surface ?? null, ctx.action_class ?? null, nowIso, nowIso);
        out.item = item;
        lines.push(`Open item ${item}: ${(action && (action.summary || action.kind)) || 'the step'} is not done (${why}).`);
      }
    }
  }
  out.emitted = [...kept, ...lines].join(' ').trim();
  return out;
}

/**
 * US-07-R17: pre-emission filter. The draft is buffered and matched with fenced and quoted text masked. On a hit that is not
 * excluded, a revision request goes back to the reasoning component (`revise`) at most `maxRevisions` times (default 2).
 * A draft that still hits after that goes through recognize(), so nothing is emitted that the engine would have rewritten.
 */
export async function preEmit(db, input, ports = {}) {
  const max = ports.maxRevisions ?? 2;
  const rows = await registerRows(db);
  const ctx = input.ctx || {};
  let draft = String(input.draft ?? ''), revisions = 0;
  for (;;) {
    const hits = matchDraft(rows, draft, input.scope || 'report', await classify(ports, draft, rows), ports.classifier_threshold);
    if (!hits.length || revisions >= max || !ports.revise || await exclusion(db, ctx)) break;
    const next = await ports.revise({ draft, attempt: revisions + 1, max, hits: hits.map(h => ({ pattern_key: h.pattern_key, excerpt: h.excerpt, redirect: h.row.auto_remediation })) });
    revisions++;
    if (typeof next !== 'string' || !next.trim() || next === draft) break;
    draft = next;
  }
  const res = await recognize(db, { ...input, draft, rows, source_ref: input.source_ref ?? (revisions ? `revision ${revisions}` : undefined) }, ports);
  return { ...res, revisions };
}

/** The state signature `silent_drop`: an item that left the active set with no disposition is a hit (one per item). */
export async function scanState(db, { now = Date.now(), source = 'tick' } = {}) {
  const nowIso = iso(now);
  const drops = await all(db, `SELECT id FROM items WHERE status IN ('done','superseded','cancelled') AND (disposition IS NULL OR disposition = '')
      AND id NOT IN (SELECT source_ref FROM governance_false_stop_hits WHERE pattern_key = 'silent_drop' AND source_ref IS NOT NULL)`);
  for (const d of drops) {
    await run(db, `INSERT INTO governance_false_stop_hits (ts, pattern_key, source, source_ref, excerpt, excluded) VALUES (?, 'silent_drop', ?, ?, ?, 0)`,
      nowIso, source, d.id, `item ${d.id} left the active set with no disposition`);
  }
  return drops.map(d => d.id);
}

/** Judge a stored scan after the fact: 1 = it was a false stop, 0 = it was not. The labels are what replay scores against. */
export async function labelScan(db, scanId, label) {
  if (label !== 0 && label !== 1) throw new Error('label must be 0 or 1');
  await run(db, `UPDATE governance_scans SET label = ? WHERE id = ?`, label, scanId);
}

/** The rates of section 3.1 over a window: share of scanned outputs with a non-excluded hit, per signature. Target 0. */
export async function rates(db, { now = Date.now(), days = 7 } = {}) {
  const since = iso(now - days * 86400e3);
  const scans = (await first(db, `SELECT COUNT(*) AS n FROM governance_scans WHERE ts >= ?`, since)).n;
  const by = await all(db, `SELECT pattern_key, COUNT(DISTINCT scan_id) AS n FROM governance_false_stop_hits WHERE ts >= ? AND excluded = 0 AND scan_id IS NOT NULL GROUP BY pattern_key`, since);
  const any = (await first(db, `SELECT COUNT(DISTINCT scan_id) AS n FROM governance_false_stop_hits WHERE ts >= ? AND excluded = 0 AND scan_id IS NOT NULL`, since)).n;
  const rate = (k) => (scans ? ((by.find(b => b.pattern_key === k) || { n: 0 }).n / scans) : null);
  return { scans, false_stop_rate: scans ? any / scans : null, conditional_offer_rate: rate('conditional_offer'), question_rate: rate('question_ending'),
    actor_assignment_rate: scans ? (((by.find(b => b.pattern_key === 'principal_actor') || { n: 0 }).n + (by.find(b => b.pattern_key === 'principal_executor') || { n: 0 }).n) / scans) : null,
    narration_rate: rate('narration') };
}
