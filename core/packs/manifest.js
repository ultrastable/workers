// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Pack manifest validation (US-SPEC-21 s4, US-21-R02, R11). Returns a list of error strings; empty means valid.
export const CLASSES = ['A', 'B', 'C', 'D'];
export const CONSENT_MODES = ['none', 'single_opt_in', 'double_opt_in'];
export const APPROVAL_MODES = ['by_rung', 'always'];

// Section 3 behaviours, matched against what a pack says it does.
export const OUT_OF_BOUNDS = [
  ['money_movement', /\b(buy|buys|buying|purchase|purchases|purchasing|trade|trades|trading)\b|\b(move|moves|moving|transfer|transfers|transferring|wire|wires|wiring|send|sends|sending)\s+(money|funds|payments?)\b|payment details|card numbers?/i],
  ['signing_or_filing', /\b(sign|signs|signing|file|files|filing|submit|submits|submitting)\b[^.;]{0,40}\b(legal|government|tax|patent|trademark|court|instrument|contract|form|forms)\b|\b(legal|government|tax|patent|trademark|court)\b[^.;]{0,30}\b(filing|signing|submission)\b/i],
  ['impersonation', /imperson|\bpos(t|ts|ting)\s+as\s+(a\s+|the\s+)?(person|user|human|someone|owner)|pretend(s|ing)?\s+to\s+be|\bpose\s+as\b/i],
  ['disinformation', /disinformation|misinformation|inauthentic|astroturf|sock\s?pupp|fake\s+(reviews?|accounts?|followers?)|manipulat\w*\s+(vulnerable|people)/i],
  ['surveillance', /surveil|stalk|\bdoxx?\b|\bprofil(e|es|ing)\s+(of\s+)?(individuals?|people|persons|users)|\btrack(s|ing)?\s+(individuals?|people|persons)/i],
  ['bypass_controls', /bypass|circumvent|\bevad(e|es|ing)\b|captcha|disabl\w*\s+(the\s+)?(guard|caps?|kill\s?switch|gate)|\bignor\w*\s+(the\s+)?(unsubscribe|suppression|rate.?limit|terms)/i],
  ['other_credentials', /\b(store|stores|storing|enter|enters|entering|collect|collects|collecting)\s+(another|other|someone|users?'?s?)\s+(person'?s?\s+)?(passwords?|credentials)/i],
];

const TLDS = new Set(['com', 'org', 'net', 'io', 'dev', 'app', 'ai', 'co', 'us', 'uk', 'de', 'fr', 'eu', 'info', 'biz', 'xyz', 'cloud', 'edu', 'gov', 'me', 'tv']);
const PLACEHOLDER = /(^|\.)(example(\.(com|org|net))?|test|invalid|localhost)$/i;
const HEX32 = /\b[0-9a-f]{32}\b/i;

function scanDefaults(value, path, tenantNames, errors) {
  if (Array.isArray(value)) return value.forEach((v, i) => scanDefaults(v, `${path}[${i}]`, tenantNames, errors));
  if (value && typeof value === 'object') return Object.entries(value).forEach(([k, v]) => scanDefaults(v, `${path}.${k}`, tenantNames, errors));
  if (typeof value !== 'string') return;
  const lower = value.toLowerCase();
  for (const n of tenantNames) if (n && lower.includes(String(n).toLowerCase())) errors.push(`${path}: names a tenant (${n}); tenant values come from configuration (US-21-R11)`);
  if (HEX32.test(value)) errors.push(`${path}: looks like an account id (US-21-R11)`);
  for (const m of value.match(/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+/gi) || []) {
    const tld = m.split('.').pop().toLowerCase();
    if (TLDS.has(tld) && !PLACEHOLDER.test(m)) errors.push(`${path}: names a real host (${m}); use configuration or an example.* placeholder (US-21-R11)`);
  }
}

const isStr = v => typeof v === 'string' && v.trim() !== '';
const isStrList = v => Array.isArray(v) && v.every(isStr);

export function parseEntry(entry) {
  if (typeof entry === 'string') { const [module, exp = 'default'] = entry.split('#'); return { module, export: exp }; }
  if (entry && typeof entry === 'object') return { module: entry.module, export: entry.export || 'default' };
  return null;
}

export function validateManifest(m, { tenantNames = [], readProbeCheck = null } = {}) {
  const e = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['manifest must be an object'];
  for (const f of ['id', 'name', 'version', 'class']) if (!isStr(m[f])) e.push(`missing required field: ${f}`);
  if (isStr(m.id) && !/^[a-z][a-z0-9_]*$/.test(m.id)) e.push('id must be lower-case letters, digits and underscores, starting with a letter');
  if (isStr(m.class) && !CLASSES.includes(m.class)) e.push(`class must be one of ${CLASSES.join(', ')}`);

  const s = m.scope;
  if (!s || typeof s !== 'object') e.push('missing required field: scope');
  else {
    if (!isStrList(s.does) || !s.does.length) e.push('scope.does must be a non-empty list of plain-words strings');
    if (!isStrList(s.does_not) || !s.does_not.length) e.push('scope.does_not must be a non-empty list (it names the adjacent Section 3 items)');
    for (const line of isStrList(s.does) ? s.does : []) for (const [name, re] of OUT_OF_BOUNDS) {
      if (re.test(line)) e.push(`scope.does is out of bounds (${name}): "${line.slice(0, 80)}" (US-SPEC-21 s3)`);
    }
  }

  const c = m.charter;
  if (!c || typeof c !== 'object') e.push('missing required field: charter');
  else {
    if (!isStr(c.objective)) e.push('charter.objective is required');
    const metrics = [['charter.primary_metric', c.primary_metric]];
    if (!Array.isArray(c.guard_metrics) || c.guard_metrics.length < 1) e.push('charter.guard_metrics needs at least one guard metric (US-21-R04)');
    (c.guard_metrics || []).forEach((g, i) => metrics.push([`charter.guard_metrics[${i}]`, g]));
    for (const [where, mt] of metrics) {
      if (!mt || typeof mt !== 'object') { e.push(`${where} is required`); continue; }
      if (!isStr(mt.id)) e.push(`${where}.id is required`);
      else if (isStr(m.id) && !mt.id.startsWith(`${m.id}_`)) e.push(`${where}.id must start with "${m.id}_" so it cannot touch another pack's records (US-21-R08)`);
      if (!['>=', '<=', '>', '<', '='].includes(mt.op)) e.push(`${where}.op is invalid`);
      if (typeof mt.target !== 'number') e.push(`${where}.target must be a number`);
      if (!isStr(mt.read_probe)) e.push(`${where}.read_probe is required`);
      else {
        if (!/^\s*select\b/i.test(mt.read_probe) || /;\s*\S/.test(mt.read_probe)) e.push(`${where}.read_probe must be one SELECT`);
        else if (readProbeCheck) { try { readProbeCheck(mt.read_probe); } catch (x) { e.push(`${where}.read_probe: ${x.message}`); } }
      }
    }
  }

  const r = m.requires;
  if (!r || typeof r !== 'object') e.push('missing required field: requires');
  else {
    for (const f of ['ports', 'secrets', 'specs']) if (!isStrList(r[f])) e.push(`requires.${f} must be a list of strings`);
    for (const sec of isStrList(r.secrets) ? r.secrets : []) if (!/^[A-Z][A-Z0-9_]*$/.test(sec)) e.push(`requires.secrets entries are names only (got "${sec.slice(0, 20)}") (US-21-R09)`);
  }

  if (!Array.isArray(m.loops)) e.push('missing required field: loops');
  const loops = Array.isArray(m.loops) ? m.loops : [];
  const seen = new Set();
  loops.forEach((l, i) => {
    const w = `loops[${i}]`;
    if (!l || typeof l !== 'object') return e.push(`${w} must be an object`);
    if (!isStr(l.id)) e.push(`${w}.id is required`); else if (seen.has(l.id)) e.push(`${w}.id is duplicated`); else seen.add(l.id);
    if (!Number.isInteger(l.every_ticks) || l.every_ticks < 1) e.push(`${w}.every_ticks must be a positive integer`);
    const en = parseEntry(l.entry);
    if (!en || !isStr(en.module)) e.push(`${w}.entry is required (module and export)`);
    else if (/^([a-z]:|[\\/])/i.test(en.module) || en.module.split(/[\\/]/).includes('..') || !/\.(m?js)$/.test(en.module)) e.push(`${w}.entry must be a .js file inside the pack directory`);
    if (typeof l.outbound !== 'boolean') e.push(`${w}.outbound must be true or false`);
  });
  const anyOutbound = loops.some(l => l && l.outbound === true);
  if (m.class === 'C' && (anyOutbound || m.outbound)) e.push('a class C pack may have no outbound loop or outbound block: it drafts only (US-21-R12)');
  if (anyOutbound && !m.outbound) e.push('a loop is marked outbound but the manifest has no outbound block');
  if (m.outbound) {
    const o = m.outbound;
    if (!isStrList(o.channels) || !o.channels.length) e.push('outbound.channels must be a non-empty list');
    else for (const ch of o.channels) {
      const cap = o.caps && o.caps[ch];
      if (!cap || !Number.isInteger(cap.per_day) || cap.per_day < 0 || !Number.isInteger(cap.per_week) || cap.per_week < 0) e.push(`outbound.caps.${ch} needs integer per_day and per_week`);
    }
    if (!CONSENT_MODES.includes(o.consent)) e.push(`outbound.consent must be one of ${CONSENT_MODES.join(', ')}`);
    if (o.suppression !== true) e.push('outbound.suppression must be true (US-21-R13)');
    if (!APPROVAL_MODES.includes(o.approval)) e.push(`outbound.approval must be one of ${APPROVAL_MODES.join(', ')}`);
  }
  if (m.migrations !== undefined && !isStrList(m.migrations)) e.push('migrations must be a list of file paths');
  if (!isStr(m.enable_gate)) e.push('missing required field: enable_gate (the plain-words card the person sees)');
  if (m.defaults !== undefined) scanDefaults(m.defaults, 'defaults', tenantNames, e);
  return e;
}
