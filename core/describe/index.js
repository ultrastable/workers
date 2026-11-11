// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// core/describe: self-description and the claims registry (US-SPEC-22). Ports: db, fetch, now, readFile.
// The describe loop writes only to the database (class A, US-22-R09); publishing is a pack's job.

export const SECTIONS = [
  ['purpose', 'Purpose'], ['capabilities', 'Capabilities'], ['scope', 'Scope'], ['operation', 'Operation'],
  ['performance', 'Performance'], ['packs', 'Packs'], ['limits', 'Limits and PLANNED'], ['other', 'Other facts'],
];
const FORMS = ['statement', 'page', 'json', 'llms'];
const MARKER = /\[claim:([A-Za-z0-9._-]+)\]/g;

const iso = t => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
const ms = n => (n instanceof Date ? n.getTime() : n ?? Date.now());
const parseTs = s => Date.parse(String(s).replace(' ', 'T') + 'Z');
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
const parseJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// ---------- registry ----------

export async function addClaims(db, claims) {
  let added = 0;
  for (const c of claims) {
    const i = c.probe.indexOf(':');
    const r = await run(db, `INSERT OR IGNORE INTO describe_claims (id, text, probe_kind, probe_arg, expect, max_age_hours, public)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, c.id, c.text, c.probe.slice(0, i), c.probe.slice(i + 1), c.expect, c.max_age_hours ?? 24, c.public ?? 1);
    added += r.meta?.changes ?? 0;
  }
  return added;
}

// A claim may appear in public output only if it is public, not withdrawn, passed, and fresh (US-22-R02, T22-4).
export function isPublishable(c, now) {
  if (!c || !c.public || c.withdrawn || c.last_result !== 'pass' || !c.last_checked_at) return false;
  const age = ms(now) - parseTs(c.last_checked_at);
  return Number.isFinite(age) && age <= c.max_age_hours * 3600e3;
}

export async function publishableClaims(db, now) {
  return (await all(db, `SELECT * FROM describe_claims ORDER BY id`)).filter(c => isPublishable(c, now));
}

// Text of a claim with its probe values filled in. Numbers always carry their date (US-22-R06).
export function renderClaimText(c) {
  const ev = parseJson(c.evidence, {});
  const date = (c.last_checked_at || '').slice(0, 10);
  const hasNum = c.text.includes('{value}');
  let t = c.text.replaceAll('{value}', ev.value ?? '').replaceAll('{names}', ev.names ?? 'none').replaceAll('{date}', date);
  if (hasNum && !c.text.includes('{date}')) t = `${t.replace(/[.!?\s]+$/, '')} (as of ${date})`;
  return t;
}
export const claimSentence = c => `${renderClaimText(c).replace(/[.!?\s]+$/, '')} [claim:${c.id}].`;
export const extractClaimIds = text => [...new Set([...String(text).matchAll(MARKER)].map(m => m[1]))].sort();

// ---------- probes ----------

const SQL_FORBIDDEN = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|truncate|begin|commit|rollback)\b/i;

// Accepts one SELECT only. Anything else is rejected (probes are read-only, US-22-R01).
export function assertReadOnlySql(sql) {
  const s = String(sql).trim().replace(/;\s*$/, '');
  if (!/^select\b/i.test(s)) throw new Error('sql probe must be a single SELECT');
  if (s.includes(';')) throw new Error('sql probe must be a single statement');
  if (/--|\/\*/.test(s)) throw new Error('sql probe must not contain comments');
  if (SQL_FORBIDDEN.test(s)) throw new Error('sql probe contains a write or control keyword');
  return s;
}

const OPS = { '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b, '=': (a, b) => a === b, '!=': (a, b) => a !== b };

// Returns true, false, or null (expect not understood: the result is unknown).
export function evaluate(expect, { value, text }) {
  const e = String(expect).trim();
  if (e === 'exists') return true;
  if (e === 'nonempty') return value !== null && value !== undefined && value !== '';
  if (e.startsWith('contains:')) return String(text ?? value ?? '').includes(e.slice(9));
  if (e.startsWith('status:')) return Number(value) === Number(e.slice(7));
  const m = e.match(/^(>=|<=|!=|>|<|=)\s*(-?\d+(?:\.\d+)?)$/);
  if (m) return value === null || value === undefined || value === '' || Number.isNaN(Number(value)) ? false : OPS[m[1]](Number(value), Number(m[2]));
  return null;
}

async function measure(c, { db, fetch, now, readFile, specStatus }) {
  switch (c.probe_kind) {
    case 'sql': {
      const sql = assertReadOnlySql(c.probe_arg.replaceAll('{now}', `'${iso(ms(now))}'`));
      const row = (await all(db, sql))[0];
      if (!row) return { value: null, text: '' };
      const cols = Object.keys(row);
      return { value: row[cols[0]], names: row.names ?? undefined, text: String(row[cols[0]]) };
    }
    case 'file': {
      if (!readFile) throw new Error('no readFile port');
      let text;
      try { text = await readFile(c.probe_arg); } catch (e) { return { missing: `unreadable: ${e.message}` }; }
      return { value: text, text: String(text) };
    }
    case 'http': {
      if (!fetch) throw new Error('no fetch port');
      const res = await fetch(c.probe_arg, { method: 'GET', signal: AbortSignal.timeout(10000) });
      const text = (await res.text()).slice(0, 20000);
      return { value: res.status, text };
    }
    case 'spec': {
      if (!specStatus) throw new Error('no spec status snapshot');
      const [a, b] = c.probe_arg.includes('.') ? c.probe_arg.split('.') : [null, c.probe_arg];
      const src = a ? specStatus.by_spec?.[a] : specStatus;
      if (!src || typeof src[b] !== 'number') throw new Error(`spec status has no ${c.probe_arg}`);
      const names = b === 'PLANNED' ? (src.planned_names || specStatus.planned_names || []).slice(0, 12).join(', ') || 'none' : undefined;
      return { value: src[b], names, text: String(src[b]) };
    }
    default: throw new Error(`unknown probe kind ${c.probe_kind}`);
  }
}

export async function probeClaim(c, ports) {
  try {
    const m = await measure(c, ports);
    if (m.missing) return { result: 'fail', evidence: { detail: m.missing } };
    const ok = evaluate(c.expect, m);
    const ev = { value: typeof m.value === 'string' ? undefined : m.value, names: m.names };
    if (ok === null) return { result: 'unknown', evidence: { ...ev, detail: `expect not understood: ${c.expect}` } };
    return { result: ok ? 'pass' : 'fail', evidence: { ...ev, detail: ok ? 'expectation held' : `expected ${c.expect}, got ${String(m.value).slice(0, 80)}` } };
  } catch (e) {
    return { result: 'unknown', evidence: { detail: String(e.message).slice(0, 200) } };
  }
}

async function fileRepair(db, c, reason, nowMs, ownerRole) {
  const id = `DESCRIBE-${c.id}`;
  const existing = await first(db, `SELECT status FROM items WHERE id = ?`, id);
  if (!existing) {
    await run(db, `INSERT INTO items (id, title, kind, owner_role, done_check, closing_probe, priority, status, surface, action_class)
      VALUES (?, ?, 'fix', ?, ?, ?, 20, 'ready', 'describe', 'A')`,
      id, `Claim ${c.id} withdrawn from public output: ${reason}`.slice(0, 300), ownerRole,
      `the probe for claim ${c.id} passes again and the claim is public`, `describe:${c.id}`);
    return id;
  }
  if (['done', 'superseded', 'cancelled'].includes(existing.status)) {
    await run(db, `UPDATE items SET status='ready', disposition=NULL, updated_at=? WHERE id=?`, iso(nowMs), id);
    return id;
  }
  return null;
}

async function withdraw(db, c, reason, nowMs, ownerRole) {
  await run(db, `UPDATE describe_claims SET withdrawn=1, withdrawn_at=COALESCE(withdrawn_at, ?) WHERE id=?`, iso(nowMs), c.id);
  return fileRepair(db, c, reason, nowMs, ownerRole);
}

// Re-check every public claim. Fail or unknown withdraws it and files a repair item; a later pass reinstates it.
export async function runProbes({ db, fetch, now, readFile, specStatus, ownerRole = 'operations' }) {
  const nowMs = ms(now);
  const out = { checked: 0, pass: 0, fail: 0, unknown: 0, withdrawn: [], filed: [] };
  for (const c of await all(db, `SELECT * FROM describe_claims WHERE public = 1 ORDER BY id`)) {
    const r = await probeClaim(c, { db, fetch, now: nowMs, readFile, specStatus });
    out.checked++; out[r.result]++;
    await run(db, `UPDATE describe_claims SET last_result=?, last_checked_at=?, evidence=? WHERE id=?`, r.result, iso(nowMs), JSON.stringify(r.evidence), c.id);
    if (r.result === 'pass') {
      await run(db, `UPDATE describe_claims SET withdrawn=0, withdrawn_at=NULL WHERE id=?`, c.id);
    } else {
      out.withdrawn.push(c.id);
      const f = await withdraw(db, c, `probe ${r.result}: ${r.evidence.detail}`, nowMs, ownerRole);
      if (f) out.filed.push(f);
    }
  }
  return out;
}

// Claims whose last check is older than their freshness limit are withdrawn (US-22-R02, T22-4).
export async function withdrawStale({ db, now, ownerRole = 'operations' }) {
  const nowMs = ms(now), done = [];
  for (const c of await all(db, `SELECT * FROM describe_claims WHERE public = 1 AND withdrawn = 0`)) {
    if (isPublishable(c, nowMs)) continue;
    await withdraw(db, c, c.last_result === 'pass' ? 'stale beyond its freshness limit' : `last result ${c.last_result ?? 'none'}`, nowMs, ownerRole);
    done.push(c.id);
  }
  return done;
}

// ---------- self-model ----------

const sectionOf = id => { const p = id.split('.')[0]; return SECTIONS.some(([k]) => k === p) ? p : 'other'; };

// Out-of-scope rows of a SCOPE.md table, for the scope argument of buildSelfModel.
export function parseScopeMd(md) {
  const out = []; let on = false;
  for (const line of String(md).split('\n')) {
    if (/^##\s+What it does not do/i.test(line)) { on = true; continue; }
    if (on && /^##\s/.test(line)) break;
    const m = on && line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
    if (m && !/^(-+|Out of scope)$/i.test(m[1])) out.push({ item: m[1], why: m[2] });
  }
  return out;
}

// specStatus: { BUILT, RUNNING_ONLY, PLANNED, 'NOT COVERED', total, planned_names }. packs: [{id, enabled, charter, guard_metrics}].
// scope: { purpose?, in_scope?: [], out_of_scope?: [] }. Built only from records and the injected snapshots.
export async function buildSelfModel({ db, specStatus = null, packs = [], scope = {}, now = Date.now() }) {
  const claims = await publishableClaims(db, now);
  const n = async (sql) => (await first(db, sql))?.n ?? 0;
  const purposeRow = await first(db, `SELECT value FROM org WHERE key = 'purpose'`);
  const lastTick = await first(db, `SELECT finished_at FROM tick_runs WHERE finished_at IS NOT NULL AND steps_completed = steps_total ORDER BY id DESC LIMIT 1`);
  const facts = {
    purpose: scope.purpose || purposeRow?.value || null,
    capabilities: { built: specStatus?.BUILT ?? null, running_only: specStatus?.RUNNING_ONLY ?? null, planned: specStatus?.PLANNED ?? null, total: specStatus?.total ?? null },
    scope: { in_scope: scope.in_scope || [], out_of_scope: scope.out_of_scope || [] },
    operation: { ticks_completed: await n(`SELECT COUNT(*) AS n FROM tick_runs WHERE steps_completed = steps_total`), last_complete_tick_at: lastTick?.finished_at || null },
    performance: {
      predictions_scored: await n(`SELECT COUNT(*) AS n FROM predictions WHERE verdict IS NOT NULL`),
      predictions_hit: await n(`SELECT COUNT(*) AS n FROM predictions WHERE verdict = 'hit'`),
      items_done: await n(`SELECT COUNT(*) AS n FROM items WHERE status = 'done'`),
      verified_outcomes: await n(`SELECT COUNT(*) AS n FROM outcomes WHERE result = 'verified'`),
      autonomy_rungs: await all(db, `SELECT surface, action_class, rung FROM trust_ledger ORDER BY surface, action_class`),
    },
    packs: packs.map(p => ({ id: p.id, enabled: !!p.enabled, charter: p.charter || null, guard_metrics: p.guard_metrics || [] })),
    limits: {
      planned_names: specStatus?.planned_names || [],
      blocked_items: (await all(db, `SELECT id FROM items WHERE status = 'blocked' ORDER BY id`)).map(r => r.id),
      open_gate_cards: await n(`SELECT COUNT(*) AS n FROM gate_cards WHERE status = 'open'`),
    },
  };
  const sections = SECTIONS.map(([key, title]) => ({ key, title, claim_ids: claims.filter(c => sectionOf(c.id) === key).map(c => c.id) }));
  const warnings = sections.filter(s => s.key !== 'other' && !s.claim_ids.length).map(s => `section ${s.key} has no published claim`);
  return { generated_at: iso(ms(now)), sections, claim_ids: claims.map(c => c.id), facts, warnings };
}

// ---------- three forms from one model ----------

// Default compose: deterministic. A model may replace it, but the voice checker still gates every sentence (US-22-R05).
export const defaultCompose = ({ form, claims }) =>
  form === 'statement' ? claims.map(c => c.sentence).join(' ') : claims.map(c => `- ${c.sentence}`).join('\n');

export async function render(model, claims, { compose = defaultCompose, title = 'About this organization' } = {}) {
  const byId = new Map(claims.map(c => [c.id, c]));
  const view = id => { const c = byId.get(id); return { id, text: renderClaimText(c), sentence: claimSentence(c), claim: c }; };
  const secs = model.sections.map(s => ({ ...s, items: s.claim_ids.filter(id => byId.has(id)).map(view) })).filter(s => s.items.length || s.key !== 'other');
  const lead = ['capabilities', 'limits'];
  const statementItems = secs.filter(s => lead.includes(s.key)).concat(secs.filter(s => !lead.includes(s.key))).flatMap(s => s.items);
  const ids = statementItems.map(i => i.id).sort();
  const statement = (await compose({ form: 'statement', section: 'all', claims: statementItems })).trim();
  const body = async form => {
    const parts = [];
    for (const s of secs) {
      const text = s.items.length ? (await compose({ form, section: s.key, claims: s.items })).trim() : '_No published claim for this section._';
      parts.push(`## ${s.title}\n\n${text}`);
    }
    return parts;
  };
  const quote = model.facts?.purpose ? [`> ${String(model.facts.purpose).replace(/\n+/g, ' ')}`] : [];
  const page = [`# ${title}`, `_Generated ${model.generated_at} from records. Every sentence carries a claim id._`, ...quote, ...(await body('page'))].join('\n\n') + '\n';
  const llms = [`# ${title}`, ...(await body('llms'))].join('\n\n') + '\n';
  const json = JSON.stringify({
    title, generated_at: model.generated_at, claim_ids: ids,
    sections: secs.map(s => ({ key: s.key, title: s.title, claims: s.items.map(i => ({ id: i.id, text: i.text, as_of: (i.claim.last_checked_at || '').slice(0, 10), evidence: parseJson(i.claim.evidence, {}) })) })),
  }, null, 2);
  return { statement: statement + '\n', page, json, llms, claim_ids: ids };
}

// ---------- voice checker (run by a different agent from the writer, US-22-R07) ----------

const stripMarkers = s => s.replace(MARKER, '');
const DATE = /\b\d{4}-\d{2}-\d{2}\b/;

function* sentences(text) {
  for (const raw of String(text).split('\n')) {
    const line = raw.trim().replace(/^([-*]|\d+\.)\s+/, '');
    if (!line || /^(#|>|\|)/.test(line) || /^_.*_$/.test(line)) continue;
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z[])/)) if (s.trim()) yield s.trim();
  }
}

// Pure function of (text, claims, rules): it never sees or calls the writer. claims = the registry claims allowed in output.
export function checkVoice(text, claims, voiceRules = {}, { enabledPacks = [] } = {}) {
  const byId = new Map((claims || []).map(c => [c.id, c]));
  const negation = new RegExp(`\\b(${(voiceRules.negation || ['not', 'never', 'no']).join('|')})\\b`, 'i');
  const violations = [];
  const bad = (sentence, rule, detail) => violations.push({ sentence, rule, detail });
  for (const s of sentences(text)) {
    const ids = [...s.matchAll(MARKER)].map(m => m[1]);
    if (!ids.length) { bad(s, 'no_claim', 'sentence carries no claim id'); continue; }
    const unknown = ids.filter(id => !byId.has(id));
    if (unknown.length) { bad(s, 'unknown_claim', `not in the registry: ${unknown.join(', ')}`); continue; }
    const body = stripMarkers(s);
    const allowedNums = new Set(ids.map(id => renderClaimText(byId.get(id))).join(' ').match(/\d+(?:\.\d+)?/g) || []);
    const nums = body.match(/\d+(?:\.\d+)?/g) || [];
    if (nums.length && !DATE.test(body) && !/\bestimate/i.test(body)) bad(s, 'number_without_date', 'numbers must carry a date or be labeled as an estimate');
    for (const num of nums) if (!allowedNums.has(num)) { bad(s, 'number_not_in_claim', `number ${num} is not in the cited claim`); break; }
    for (const b of voiceRules.banned || []) if (body.toLowerCase().includes(b.toLowerCase())) bad(s, 'banned_phrase', b);
    for (const g of voiceRules.out_of_scope || []) {
      if (enabledPacks.includes(g.pack) || negation.test(body)) continue;
      const hit = (g.terms || []).find(t => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(body));
      if (hit) bad(s, 'out_of_scope', `${hit} is out of scope unless the ${g.pack} pack is enabled`);
    }
  }
  return { ok: violations.length === 0, version: voiceRules.version || null, violations };
}

// ---------- the loop ----------

async function generate({ db, now, specStatus, packs, scope, compose, voiceRules, checker = checkVoice, title }) {
  const model = await buildSelfModel({ db, specStatus, packs, scope, now });
  const claims = await publishableClaims(db, now);
  const out = await render(model, claims, { compose, title });
  const enabledPacks = packs.filter(p => p.enabled).map(p => p.id);
  const problems = [];
  for (const f of ['statement', 'page', 'llms']) {
    const r = checker(out[f], claims, voiceRules, { enabledPacks });
    if (!r.ok) problems.push({ form: f, violations: r.violations });
  }
  return { model, out, problems };
}

// One pass of the loop: probe, withdraw, build, render, check, and only then store (class A: db writes only).
export async function describeOnce({ db, fetch, now, readFile, specStatus, packs = [], scope = {}, compose, voiceRules = {}, checker, ownerRole = 'operations', title }) {
  const nowMs = ms(now);
  const probes = await runProbes({ db, fetch, now: nowMs, readFile, specStatus, ownerRole });
  const stale = await withdrawStale({ db, now: nowMs, ownerRole });
  const g = await generate({ db, now: nowMs, specStatus, packs, scope, compose, voiceRules, checker, title });
  if (g.problems.length) {
    const id = `DESCRIBE-voice-${iso(nowMs).slice(0, 10)}`;
    if (!(await first(db, `SELECT id FROM items WHERE id = ?`, id))) {
      await run(db, `INSERT INTO items (id, title, kind, owner_role, done_check, priority, status, surface, action_class)
        VALUES (?, ?, 'fix', ?, 'the voice checker accepts the next generated description', 20, 'ready', 'describe', 'A')`,
        id, `Voice check rejected generated output: ${g.problems.map(p => `${p.form}:${p.violations[0].rule}`).join(', ')}`.slice(0, 300), ownerRole);
    }
    return { probes, stale, stored: false, problems: g.problems };
  }
  const at = iso(nowMs);
  for (const f of FORMS) await run(db, `INSERT INTO describe_outputs (form, claim_ids, body, generated_at) VALUES (?, ?, ?, ?)`, f, JSON.stringify(g.out.claim_ids), g.out[f], at);
  return { probes, stale, stored: true, problems: [], claim_ids: g.out.claim_ids };
}

// Plug into runTick: runTick(db, { config, extraSteps: [...describeExtraSteps(opts)] }). Writes only to the db.
// opts: { fetch, readFile, getSpecStatus: async () => snapshot (or specStatus), packs, scope, compose, voiceRules, checker, ownerRole, title }
export function describeExtraSteps(opts = {}) {
  return [{
    name: 'describe',
    async run(db, ctx) {
      const specStatus = opts.getSpecStatus ? await opts.getSpecStatus() : opts.specStatus || null;
      const r = await describeOnce({ ...opts, db, now: ctx.now, specStatus });
      ctx.notes.push(`describe: ${r.probes.pass}/${r.probes.checked} claims pass, ${r.probes.withdrawn.length} withdrawn, output ${r.stored ? 'stored' : 'rejected by voice check'}`);
    },
  }];
}

// ---------- HTTP ----------

const TYPES = { page: 'text/markdown; charset=utf-8', json: 'application/json; charset=utf-8', llms: 'text/plain; charset=utf-8' };
const ROUTES = { '/describe': 'page', '/describe.json': 'json', '/llms.txt': 'llms' };

// handle(request, { db, now, specStatus, packs, scope, compose, voiceRules }). Serves the latest stored output only while
// every claim in it is still publishable; otherwise it re-renders from the live registry (nothing is written), so a
// withdrawn or stale claim never stays on the page (US-22-R02).
export async function handle(request, ctx) {
  const url = new URL(request.url);
  const form = ROUTES[url.pathname.replace(/\/+$/, '') || '/'];
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
  if (!form) return new Response('not found', { status: 404 });
  const nowMs = ms(ctx.now);
  const row = await first(ctx.db, `SELECT body, claim_ids FROM describe_outputs WHERE form = ? ORDER BY id DESC LIMIT 1`, form);
  const ok = new Set((await publishableClaims(ctx.db, nowMs)).map(c => c.id));
  let body = null;
  if (row && parseJson(row.claim_ids, []).every(id => ok.has(id))) body = row.body;
  else if (row) {
    const g = await generate({ db: ctx.db, now: nowMs, specStatus: ctx.specStatus || null, packs: ctx.packs || [], scope: ctx.scope || {}, compose: ctx.compose, voiceRules: ctx.voiceRules || {}, checker: ctx.checker });
    if (!g.problems.length && g.out.claim_ids.length) body = g.out[form];
  }
  if (body === null) return new Response('no published description yet', { status: 404 });
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers: { 'content-type': TYPES[form], 'cache-control': 'public, max-age=300' } });
}
