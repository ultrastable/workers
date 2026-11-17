// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// core/statements: claims are code. A published statement (a methodology sentence, a feature claim, a number) is an entry in a registry; its text
// is rendered from the live configuration (a number is a template, never typed prose) and every entry carries a `verify` probe that exercises the
// real behaviour and throws when the statement is false. A page built from the registry marks each statement with data-claim; `audit` then fails
// on a statement with no probe, a probe that fails, a registry entry the page never shows, a data-claim the registry does not know, and any prose
// on the page that is not bound to a statement. Tenant-agnostic: the registry, the config and the probes are the tenant's. See README.md.
//   statement = { id, section?, text: string | (ctx) => string (HTML, no <span>), verify: async (ctx) => void (throws when false), env?: 'any' | 'ci' (a 'ci' probe needs files or tools and runs only there), evidence?: 'file or test that holds the behaviour' }
export const START = '<!--statements:start-->', END = '<!--statements:end-->', LIVE_START = '<!--live:start-->', LIVE_END = '<!--live:end-->';
const ID = /^[a-z0-9][a-z0-9-]*$/;

export function defineStatements(list) {
  const seen = new Set(), errors = [];
  for (const s of list) {
    if (!s || !ID.test(s.id || '')) { errors.push('statement id must be kebab-case: ' + (s && s.id)); continue; }
    if (seen.has(s.id)) errors.push('duplicate statement ' + s.id); seen.add(s.id);
    if (typeof s.verify !== 'function') errors.push(s.id + ': no verify probe (a statement without a test is not allowed)');
    if (typeof s.text !== 'string' && typeof s.text !== 'function') errors.push(s.id + ': text must be a string or a function of the config');
    if (typeof s.text === 'string' && /[0-9]/.test(s.text)) errors.push(s.id + ': static text contains a number; write text as a function of the config so the number is read from the code');
    if (typeof s.text === 'string' && /<span/i.test(s.text)) errors.push(s.id + ': text may not contain <span>');
  }
  if (errors.length) throw new Error('invalid statements: ' + errors.join('; '));
  return Object.freeze([...list]);
}
export const textOf = (s, ctx) => { const t = typeof s.text === 'function' ? s.text(ctx) : s.text; if (/<span/i.test(t)) throw new Error(s.id + ': text may not contain <span>'); return String(t); };
export const statement = (reg, id, ctx) => { const s = reg.find(x => x.id === id); if (!s) throw new Error('unknown statement ' + id); return `<span data-claim="${id}">${textOf(s, ctx)}</span>`; };
export const live = html => `${LIVE_START}${html}${LIVE_END}`;
export const region = html => `${START}${html}${END}`;

// run every probe; a probe that throws (or is not a function) fails its statement
export async function verifyAll(reg, ctx, { env = 'ci' } = {}) {
  const results = [];
  for (const s of reg) {
    if (s.env === 'ci' && env !== 'ci') { results.push({ id: s.id, ok: true, skipped: 'ci-only', evidence: s.evidence || null }); continue; }
    try { await s.verify(ctx); results.push({ id: s.id, ok: true, evidence: s.evidence || null }); }
    catch (e) { results.push({ id: s.id, ok: false, error: String((e && e.message) || e), evidence: s.evidence || null }); }
  }
  return { total: results.length, passed: results.filter(r => r.ok && !r.skipped).length, skipped: results.filter(r => r.skipped).length, failed: results.filter(r => !r.ok), results };
}

const visible = h => h.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/[^\p{L}]+/gu, ' ').trim();
// the page, checked against the registry: every statement shown exactly where bound, nothing unbound in the region
export function auditHtml(reg, html) {
  const a = html.indexOf(START), b = html.indexOf(END);
  if (a < 0 || b < a) return { ok: false, unbound: [], unknown: [], unrendered: reg.map(s => s.id), problems: ['no statements region'] };
  let body = html.slice(a + START.length, b);
  const shown = [...body.matchAll(/data-claim="([^"]+)"/g)].map(m => m[1]);
  const known = new Set(reg.map(s => s.id)), unknown = [...new Set(shown.filter(id => !known.has(id)))], unrendered = reg.filter(s => !shown.includes(s.id)).map(s => s.id);
  body = body.replace(new RegExp(LIVE_START + '[\\s\\S]*?' + LIVE_END, 'g'), ' ').replace(/<span data-claim="[^"]*">[\s\S]*?<\/span>/g, ' ').replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/g, ' ');
  const unbound = visible(body) ? [visible(body).slice(0, 200)] : [];
  return { ok: !unknown.length && !unrendered.length && !unbound.length, unbound, unknown, unrendered, problems: [] };
}
// the whole proof: probes pass and the page matches the registry. This is what a test asserts.
export async function proof(reg, html, ctx, opts) {
  const v = await verifyAll(reg, ctx, opts), a = auditHtml(reg, html);
  return { ok: v.failed.length === 0 && a.ok, total: v.total, passed: v.passed, skipped: v.skipped, failed: v.failed, audit: a };
}
export const describe = (reg, ctx) => reg.map(s => ({ id: s.id, section: s.section || null, env: s.env || 'any', text: textOf(s, ctx).replace(/<[^>]+>/g, ''), evidence: s.evidence || null }));
