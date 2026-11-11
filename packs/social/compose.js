// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Loops 1 and 2: compose from claims, check, and queue. The default writer is a deterministic template; a model may phrase
// through settings.ports.compose, and its output still has to pass the checker, so it cannot add a fact.
import { publishableClaims, claimSentence } from '../../core/describe/index.js';
import { run, iso } from '../../core/kernel/util.js';
import { checkPost } from './check.js';
import { addUtm, truncate } from './text.js';
import { cfg, stripMarkers } from './lib.js';
import { enqueue, backlog, recentClaimIds } from './queue.js';

// Returns marked text: claim sentences (each with its [claim:id]) plus an optional link line.
export function defaultCompose({ claims, maxLength, linkUrl, maxSentences = 2 }) {
  const room = maxLength - (linkUrl ? linkUrl.length + 1 : 0);
  const picked = [];
  for (const c of claims) {
    const next = [...picked, claimSentence(c)];
    if (picked.length >= maxSentences || stripMarkers(next.join(' ')).length > room) break;
    picked.push(claimSentence(c));
  }
  if (!picked.length) return '';
  return picked.join(' ') + (linkUrl ? `\n${linkUrl}` : '');
}

export async function composeLoop({ db, ctx, now, settings }) {
  const s = cfg(settings);
  const t = now();
  if (await backlog(db) >= s.max_backlog) { ctx?.notes?.push('social compose: backlog full'); return; }
  const claims = (await publishableClaims(db, t)).filter(c => !s.claim_prefixes || s.claim_prefixes.some(p => c.id.startsWith(p)));
  const used = await recentClaimIds(db, t, s.repeat_days);
  const fresh = claims.filter(c => !used.has(c.id));
  const compose = s.ports.compose || defaultCompose;
  let made = 0, rejected = 0;
  for (let i = 0; i < s.max_per_run && fresh.length; i++) {
    const pick = fresh.splice(0, s.ports.compose ? 3 : 1);
    const raw = String(await compose({ claims: pick, maxLength: s.max_length, linkUrl: s.link_url, maxSentences: s.max_sentences }) || '');
    let verdict = raw ? checkPost(raw, claims, { allowlist: s.allowlist, voiceRules: s.voiceRules }) : { ok: false, violations: [{ rule: 'empty', detail: 'nothing composed' }] };
    if (verdict.ok && s.ports.checker) {
      try { verdict = await s.ports.checker(raw, claims, { allowlist: s.allowlist }); } catch (e) { verdict = { ok: false, violations: [{ rule: 'checker_error', detail: e.message }] }; }
    }
    if (!verdict.ok) {
      rejected++;
      await run(db, `INSERT INTO social_rejections (at, text, violations) VALUES (?,?,?)`, iso(t), raw.slice(0, 1000), JSON.stringify(verdict.violations));
      continue;
    }
    const cited = [...new Set([...raw.matchAll(/\[claim:([A-Za-z0-9._-]+)\]/g)].map(m => m[1]))].sort();
    let text = addUtm(stripMarkers(raw), s.utm);
    text = truncate(text, s.max_length);              // last resort; a URL is never split
    const r = await enqueue({ db, now, s, text, claimIds: cited });
    if (r.created) made++;
  }
  ctx?.notes?.push(`social compose: ${made} queued, ${rejected} rejected`);
}
