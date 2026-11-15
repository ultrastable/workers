// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The data the recognition engine and the amendment loop start from (US-SPEC-07 section 3.1): the ten signature shapes,
// the commitments no amendment may remove, and the protected limits no amendment may weaken (US-07-R04).
export const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
export const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
export const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
export const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
export function hash(s) { // FNV-1a over the text; tells two versions apart, not a security digest
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

export const COMMITMENTS = [
  { key: 'interrupt-gate', text: 'Pause only for a step that is irreversible and identity-bound, after engineering reversibility.' },
  { key: 'alignment-floor', text: 'Stay honest, non-harmful and trust-preserving.' },
  { key: 'affirmative-adoption', text: 'Each identified action is executed and verified in the same output.' },
  { key: 'affirmative-default', text: 'The answer to a reversible, in-scope question is yes, within the interrupt gate, harness and classifier refusals, secret locks and live claims.' },
  { key: 'actor-commitment', text: 'No sentence of a report has the principal as the subject of an action.' },
];

export const PROTECTED_LIMITS = [
  { key: 'harness-permission-checks', terms: ['harness', 'permission check'] },
  { key: 'classifier-refusals', terms: ['classifier', 'safety refusal'] },
  { key: 'secret-lock', terms: ['secret lock', 'secret value', 'secrets'] },
  { key: 'live-claims', terms: ['live claim', "another agent's claim"] },
  { key: 'outreach-consent', terms: ['consent', 'suppression', 'opt-out', 'opt out'] },
  { key: 'plane-separation', terms: ['plane separation'] },
  { key: 'interrupt-gate', terms: ['interrupt gate'] },
  { key: 'principal-override', terms: ["principal's override", 'principal override', "owner's override", 'owner override'] },
];

/** The block every fleet-loop prompt must carry (US-07-R16). */
export function commitmentsBlock() {
  return ['Commitments:', ...COMMITMENTS.map(c => `- [commitment:${c.key}] ${c.text}`)].join('\n');
}
/** US-07-R16: which commitments a configuration or prompt lacks. Empty means it may be loaded. */
export function missingCommitments(text) {
  const t = String(text ?? '');
  return COMMITMENTS.filter(c => !t.includes(`[commitment:${c.key}] ${c.text}`)).map(c => c.key);
}
/** Load a prompt into a fleet loop, or refuse it. */
export function loadLoopPrompt({ name, prompt }) {
  const missing = missingCommitments(prompt);
  if (missing.length) throw new Error(`prompt ${name || ''} rejected: commitments missing: ${missing.join(', ')}`);
  return { name, prompt, commitments_hash: hash(JSON.stringify(COMMITMENTS)) };
}

// key, shape, cause class, redirect, requires_action, trust event, weight, commitment, phrases (scope '*' unless given as [scope, phrase])
export const DEFAULT_REGISTER = [
  ['conditional_offer', 'Conditional offer', 'deferred decision', 'adopt, execute, emit as done', 1, 'unnecessary_question', -0.05, 'affirmative-adoption',
    ['if you want', "if you'd like", 'let me know if', 'shall i', 'would you like me to', 'do you want me to']],
  ['question_ending', 'Report ending in a question', 'deferred decision', 'decide, state the decision as fact', 1, 'unnecessary_question', -0.05, 'affirmative-default',
    ['re:\\?\\s*$', 'your call']],
  ['menu', 'Menu', 'deferred decision', 'choose, execute, mark alternative superseded', 1, 'unnecessary_question', -0.05, 'affirmative-default',
    ['re:\\beither\\b[^.?!]{1,80}\\bor\\b', 'two options', 'which would you prefer', 're:\\boption (a|1)\\b']],
  ['blocker_no_surfaces', 'Blocker without surface coverage', 'unproven blocker', 'enumerate surfaces, test each, then report', 1, 'handoff_of_executable_step', -0.10, null,
    ["can't", 'cannot', 'refused', 'no access', 'unable to']],
  ['stop_not_eligible', 'Stop not interrupt-eligible', 'false stop', 'classify; if false, re-execute the abandoned path', 1, 'unnecessary_question', -0.05, 'interrupt-gate',
    ['waiting for your', 'please confirm', "i'll wait", 'i will wait', 'paused until', 'awaiting your']],
  ['principal_executor', 'Principal as executor', 'handoff', 'dispatch from the roster', 1, 'handoff_of_executable_step', -0.10, 'actor-commitment',
    ['you could run', 'you can run', "you'll need to run", 'you will need to run']],
  ['principal_actor', 'Principal as actor', 'handoff', 'rewrite in first person and execute; else dispatch', 1, 'handoff_of_executable_step', -0.10, 'actor-commitment',
    ['needs you to', 'you should', 'you need to', 'you will have to']],
  ['silent_drop', 'Silent drop', 'lost item', 'log disposition or reopen', 0, 'silent_drop', -0.20, null, []],
  ['friction', 'Friction', 'doctrine defect', 'generate, red-team, adopt an amendment', 0, null, 0, null,
    [['principal', "i shouldn't have to"], ['principal', 'every time'], ['principal', 'how many times']]],
  ['narration', 'Narration', 'described, not done', 'produce the changed artifact in the same output', 1, 'unnecessary_question', -0.05, 'affirmative-adoption',
    ['the fix is to', 'the solution is to', 'you would need to change']],
];
const HEURISTIC = { silent_drop: 'state' };
export const INITIAL_VERSION = '0.1.0';

export async function registerRows(db) {
  const rows = await all(db, `SELECT * FROM governance_false_stop_register ORDER BY pattern_key`);
  const phrases = await all(db, `SELECT * FROM governance_false_stop_phrases ORDER BY pattern_key, scope, phrase`);
  return rows.map(r => ({ ...r, phrases: phrases.filter(p => p.pattern_key === r.pattern_key).map(p => ({ scope: p.scope, phrase: p.phrase })) }));
}
export const registerHash = (rows) => hash(JSON.stringify(rows));

/** Install the default register once and write the first lineage row. Signatures are rows: they extend without a code change. */
export async function seedRegister(db, { now = Date.now() } = {}) {
  for (const [key, pattern, cause, redirect, act, event, weight, commitment, phrases] of DEFAULT_REGISTER) {
    await run(db, `INSERT OR IGNORE INTO governance_false_stop_register (pattern_key, pattern, cause_class, detection_heuristic, auto_remediation, requires_action, trust_event, weight, commitment) VALUES (?,?,?,?,?,?,?,?,?)`,
      key, pattern, cause, HEURISTIC[key] || 'phrase', redirect, act, event, weight, commitment);
    for (const p of phrases) {
      const [scope, phrase] = Array.isArray(p) ? p : ['*', p];
      await run(db, `INSERT OR IGNORE INTO governance_false_stop_phrases (pattern_key, scope, phrase) VALUES (?,?,?)`, key, scope, phrase);
    }
  }
  if (!(await first(db, `SELECT 1 AS x FROM governance_lineage LIMIT 1`))) {
    await run(db, `INSERT INTO governance_lineage (version, parent_version, proposal_id, register_hash, commitments_hash, adopted_by, adopted_at) VALUES (?, NULL, NULL, ?, ?, 'seed', ?)`,
      INITIAL_VERSION, registerHash(await registerRows(db)), hash(JSON.stringify(COMMITMENTS)), iso(now));
  }
  return (await first(db, `SELECT COUNT(*) AS n FROM governance_false_stop_register`)).n;
}
