// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The principles register: the system's own memory of what autonomy means and what the owner has directed.
// It is data, so the system can read it (console Help, self-description, agents) and so a test can prove that no
// directive is an open loop: each is enforced by code that exists, or is tracked by an open issue.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REGISTER_PATH = path.join(HERE, 'principles.json');

export function load(file = REGISTER_PATH) { return JSON.parse(readFileSync(file, 'utf8')); }

/** Structural validation. Returns a list of problems (empty means valid). */
export function validate(reg) {
  const errs = [];
  if (!reg.tagline) errs.push('tagline missing');
  const terms = new Set();
  for (const g of reg.glossary || []) {
    if (!g.term || !g.definition) errs.push(`glossary entry incomplete: ${JSON.stringify(g).slice(0, 60)}`);
    if (terms.has(g.term)) errs.push(`duplicate term: ${g.term}`);
    terms.add(g.term);
  }
  for (const g of reg.glossary || []) for (const s of g.see || []) if (!terms.has(s)) errs.push(`"${g.term}" refers to unknown term "${s}"`);
  const ids = new Set();
  for (const d of reg.directives || []) {
    for (const k of ['id', 'date', 'owner_words', 'meaning', 'status']) if (!d[k]) errs.push(`${d.id || '?'}: ${k} missing`);
    if (ids.has(d.id)) errs.push(`duplicate directive: ${d.id}`);
    ids.add(d.id);
    if (!['enforced', 'partial', 'planned'].includes(d.status)) errs.push(`${d.id}: status must be enforced, partial or planned`);
    if (d.status === 'enforced' && !(d.enforced_by || []).length) errs.push(`${d.id}: enforced but names no enforcer`);
    if (d.status !== 'enforced' && !Number.isInteger(d.tracking_issue)) errs.push(`${d.id}: ${d.status} directive needs a tracking_issue`);
  }
  return errs;
}

/** Every named enforcer must exist in the checkout. A directive whose enforcer vanished is an open loop. */
export function missingEnforcers(reg, root) {
  const missing = [];
  for (const d of reg.directives || []) for (const e of d.enforced_by || []) {
    if (!existsSync(path.join(root, e.path))) missing.push(`${d.id}: ${e.kind} ${e.path}`);
  }
  return missing;
}

/** Directives that are not fully enforced: the system's own list of loops still to close, with their trackers. */
export function openDirectives(reg) {
  return (reg.directives || []).filter(d => d.status !== 'enforced').map(d => ({ id: d.id, status: d.status, tracking_issue: d.tracking_issue }));
}

export function renderGlossary(reg) {
  const lines = [
    '<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->',
    '<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->',
    '<!-- GENERATED from core/principles/principles.json by `node core/principles/render.js --write`. Edit the JSON, not this file. -->',
    '',
    '# Principles and glossary',
    '',
    `> **${reg.tagline}**`,
    '',
    ...reg.one_line_each.map(s => `- ${s}`),
    '',
    '## Terms',
    '',
  ];
  for (const g of [...reg.glossary].sort((a, b) => a.term.localeCompare(b.term))) {
    lines.push(`**${g.term}.** ${g.definition}${g.see?.length ? ` See: ${g.see.join(', ')}.` : ''}`, '');
  }
  lines.push('## Standing directives', '', 'Each is the owner\'s instruction, kept with the code that enforces it. A directive that is not yet enforced is tracked by an issue.', '',
    '| Id | In the owner\'s words | Status | Enforced by |', '|---|---|---|---|');
  for (const d of reg.directives) {
    const by = d.status === 'enforced' ? d.enforced_by.map(e => `\`${e.path}\``).join(', ') : `${d.enforced_by.map(e => `\`${e.path}\``).join(', ')}${d.enforced_by.length ? '; ' : ''}tracked by #${d.tracking_issue}`;
    lines.push(`| ${d.id} | ${d.owner_words.replace(/\|/g, '/')} | ${d.status} | ${by} |`);
  }
  lines.push('');
  return lines.join('\n');
}
