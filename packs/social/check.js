// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The checker (US-SPEC-22 R05/R07 reused): a function separate from the writer. It rejects any sentence not backed by a fresh
// public claim, any number without a date, and any URL not on the configured allowlist. A second checker port (ideally a
// different model family) may veto further; it can never approve what this one rejected.
import { checkVoice } from '../../core/describe/index.js';
import { findUrls, hostAllowed } from './text.js';

const BARE_HOST = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*)?/gi;

export function checkPost(text, claims, { allowlist = [], voiceRules = {} } = {}) {
  const violations = [];
  const bad = (rule, detail) => violations.push({ rule, detail });
  text = String(text);
  for (const { url } of findUrls(text)) {
    let u; try { u = new URL(url); } catch { bad('url_invalid', url); continue; }
    if (u.protocol !== 'https:') bad('url_not_https', url);
    else if (!hostAllowed(u.hostname, allowlist)) bad('url_not_allowed', u.hostname);
  }
  const prose = [];
  for (const line of text.split('\n')) {
    const masked = line.replace(/https?:\/\/[^\s<>()[\]"']+/g, 'link');
    if (!line.trim() || masked.trim() === 'link') continue;       // a line that is only a link carries no claim
    for (const m of masked.replace(/\[claim:[^\]]*\]/g, '').matchAll(BARE_HOST)) if (!hostAllowed(m[0].split('/')[0].toLowerCase(), allowlist)) bad('url_not_allowed', m[0]);
    prose.push(masked);
  }
  if (!prose.length) bad('no_claim', 'the post has no claim-backed sentence');
  else {
    const r = checkVoice(prose.join('\n'), claims, voiceRules);
    for (const v of r.violations) bad(v.rule, `${v.detail}: ${String(v.sentence).slice(0, 80)}`);
  }
  return { ok: violations.length === 0, violations };
}

// Model-family guard: the writer and the checker should not share a family (a shared blind spot is not a second opinion).
export const modelFamily = m => String(m || '').toLowerCase().split(/[/:\-_.\s]/).filter(Boolean)[0] || '';

// Ports over a `complete({ model, system, prompt }) -> string` function, which the host wires to the router. Both fail closed.
export function createModelPorts({ complete, composeModel, checkerModel }) {
  if (modelFamily(composeModel) === modelFamily(checkerModel)) throw new Error('compose and checker models must be from different families');
  const compose = async ({ claims, maxLength, linkUrl }) => complete({
    model: composeModel,
    system: `Write one short public post of at most ${maxLength} characters using only the facts given. Keep each sentence's [claim:<id>] marker and every number with its date. Add no other fact.${linkUrl ? ` End with the line: ${linkUrl}` : ''}`,
    prompt: claims.map(c => `[claim:${c.id}] ${c.text}`).join('\n'),
  });
  const checker = async (text, claims) => {
    let out;
    try {
      out = JSON.parse(await complete({
        model: checkerModel,
        system: 'You are a fact checker. Reply with JSON only: {"ok":true|false,"violations":["..."]}. ok is true only if every sentence is fully supported by the listed claims.',
        prompt: `CLAIMS:\n${claims.map(c => `[claim:${c.id}] ${c.text}`).join('\n')}\n\nPOST:\n${text}`,
      }));
    } catch (e) { return { ok: false, violations: [{ rule: 'checker_unavailable', detail: String(e.message).slice(0, 100) }] }; }
    return out && out.ok === true ? { ok: true, violations: [] } : { ok: false, violations: [{ rule: 'model_check', detail: JSON.stringify(out?.violations ?? 'invalid reply').slice(0, 200) }] };
  };
  return { compose, checker };
}
