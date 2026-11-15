// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Directive enforcement (US-23-R07): for a directive the register calls enforced, a check that runs against the checkout
// and returns the ways the directive is not being met. A named enforcer file that merely exists proves nothing; these
// checks execute the enforcer against the real packs and the real ask-card rules. Node only (reads the checkout).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { validateManifest } from '../packs/manifest.js';
import { assertCoreImportsNoPacks } from '../packs/static-check.js';
import { validateCard, EXTRA_OPTIONS } from '../elicit/index.js';

/** Every pack under <root>/packs with its parsed manifest, or the reason it could not be read. */
export function readPacks(root) {
  const dir = path.join(root, 'packs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(path.join(dir, e.name, 'pack.json'))).map(e => {
    try { return { dir: e.name, manifest: JSON.parse(readFileSync(path.join(dir, e.name, 'pack.json'), 'utf8')) }; }
    catch (err) { return { dir: e.name, manifest: null, error: String(err.message) }; }
  });
}
const outboundLoops = m => (m.loops || []).filter(l => l.outbound);

/** D-SCOPE-AND-PACKS: classes and the out-of-bounds tier are enforced by manifest validation; core never imports a pack. */
export function checkScopeAndPacks(root) {
  const out = [], packs = readPacks(root);
  if (!packs.length) out.push('no pack manifest found under packs/: nothing proves the manifest gate');
  for (const p of packs) {
    if (!p.manifest) { out.push(`packs/${p.dir}: pack.json is unreadable (${p.error})`); continue; }
    for (const e of validateManifest(p.manifest)) out.push(`packs/${p.dir}: ${e}`);
    if (p.manifest.id !== p.dir) out.push(`packs/${p.dir}: manifest id "${p.manifest.id}" differs from its directory`);
    if (p.manifest.class === 'C' && outboundLoops(p.manifest).length) out.push(`packs/${p.dir}: a class C pack has an outbound loop`);
    if (p.manifest.class === 'C' && p.manifest.outbound) out.push(`packs/${p.dir}: a class C pack declares outbound channels`);
    if (!String(p.manifest.enable_gate || '').trim()) out.push(`packs/${p.dir}: no enable gate text, so nothing can be shown before it is switched on`);
  }
  try { assertCoreImportsNoPacks(root); } catch (e) { out.push(String(e.message).split('\n').slice(0, 4).join('; ')); }
  // The gate itself must refuse what the directive forbids, whatever the packs on disk look like today.
  const base = packs.find(p => p.manifest && p.manifest.class === 'C')?.manifest;
  if (base) {
    const bad = { ...base, loops: [{ id: 'send', every_ticks: 1, entry: './loops.js#send', outbound: true }] };
    if (!validateManifest(bad).length) out.push('validateManifest accepts a class C pack with an outbound loop');
  }
  return out;
}

/** D-OUTREACH-AS-LOOPS: each outreach capability is a pack of code loops with a manager charter, metrics, caps and suppression. */
export function checkOutreachAsLoops(root, required = ['email', 'social', 'video']) {
  const out = [], packs = new Map(readPacks(root).filter(p => p.manifest).map(p => [p.manifest.id, p]));
  for (const id of required) {
    const p = packs.get(id);
    if (!p) { out.push(`pack ${id} is missing`); continue; }
    const m = p.manifest, where = `packs/${p.dir}`;
    if (!(m.loops || []).length) out.push(`${where}: no code loop`);
    for (const l of m.loops || []) {
      const file = String(l.entry || '').split('#')[0];
      if (!file || !existsSync(path.join(root, 'packs', p.dir, file))) out.push(`${where}: loop ${l.id} names a module that does not exist (${l.entry})`);
      if (!(Number(l.every_ticks) >= 1)) out.push(`${where}: loop ${l.id} has no interval`);
    }
    if (!m.charter?.objective || !m.charter?.primary_metric?.id) out.push(`${where}: no manager charter with a primary metric`);
    if (!(m.charter?.guard_metrics || []).length) out.push(`${where}: no guard metric`);
    if (m.class !== 'B') out.push(`${where}: an outward-reach pack must be class B, found ${m.class}`);
    if (!outboundLoops(m).length) out.push(`${where}: no outbound loop, so nothing reaches anyone through the guard`);
    const ob = m.outbound || {};
    if (ob.suppression !== true) out.push(`${where}: suppression is not on`);
    for (const ch of ob.channels || []) { const c = (ob.caps || {})[ch]; if (!(c && Number.isFinite(c.per_day) && Number.isFinite(c.per_week))) out.push(`${where}: channel ${ch} has no daily and weekly cap`); }
    if (!(ob.channels || []).length) out.push(`${where}: no outbound channel declared`);
  }
  return out;
}

/** D-IGNORANCE-ASSUMED: an ask is answerable by recognition, in plain words, with a stated reversible default and a way to say "not sure". */
export function checkIgnoranceAssumed() {
  const out = [];
  const good = { need_id: 'N-1', question: 'Who should be able to see the page?', why: 'It decides whether a sign-in is needed.', cue: 'Think of who you would hand a printed copy to.',
    options: ['Anyone', 'Only people I invite', ...EXTRA_OPTIONS], default: 'Only people I invite', default_consequence: 'Nobody else can open it until you say so.', reversibility: 'reversible', priority: 1 };
  if (validateCard(good).length) out.push(`a plain card with options and a default is refused: ${validateCard(good).join('; ')}`);
  const must = [
    ['a card with no default', { ...good, default: '' }],
    ['a card with no stated consequence of the default', { ...good, default_consequence: '' }],
    ['a card that cannot be answered "Not sure"', { ...good, options: ['Anyone', 'Only people I invite'] }],
    ['a card with one option (recall, not recognition)', { ...good, options: ['Anyone', ...EXTRA_OPTIONS] }],
    ['a card that uses an undefined technical word', { ...good, question: 'Which database schema should the endpoint use?' }],
    ['a card with a question longer than 25 words', { ...good, question: Array.from({ length: 26 }, (_, i) => 'word' + i).join(' ') + '?' }],
  ];
  for (const [what, card] of must) if (!validateCard(card).length) out.push(`the ask-card rules accept ${what}`);
  return out;
}

export const CHECKS = {
  'D-SCOPE-AND-PACKS': checkScopeAndPacks,
  'D-OUTREACH-AS-LOOPS': checkOutreachAsLoops,
  'D-IGNORANCE-ASSUMED': checkIgnoranceAssumed,
};

/** Run the check of every directive that has one. Returns { id: [problems] } for the directives that fail. */
export function checkDirectives(reg, root) {
  const failing = {};
  for (const d of reg.directives || []) {
    const check = CHECKS[d.id];
    if (!check) continue;
    const problems = check(root);
    if (problems.length) failing[d.id] = problems;
  }
  return failing;
}

/** A directive this file checks may be called enforced only while it names this file as an enforcer and its check passes. */
export function unprovenEnforced(reg) {
  return (reg.directives || []).filter(d => CHECKS[d.id] && d.status === 'enforced' && !(d.enforced_by || []).some(e => e.path === 'core/principles/enforcement.js')).map(d => d.id);
}
