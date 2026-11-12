// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The checker: a function separate from whoever made the video. Returns { ok, violations: [{ rule, detail }] }.
import { parseIso } from '../../core/kernel/util.js';

const URL_RE = /\bhttps?:\/\/[^\s)]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|ai|co)\b[^\s)]*/gi;

export function hostAllowed(host, allowlist) {
  const h = String(host).toLowerCase();
  return allowlist.some(a => h === a.toLowerCase() || h.endsWith('.' + a.toLowerCase()));
}

// claims: describe_claims rows the caller loaded (id, public, last_result, last_checked_at, max_age_hours).
export function checkVideo(v, { claims = [], allowlist = [], max_seconds = 60, disclosure = 'AI-generated', now = Date.now() } = {}) {
  const out = [];
  const bad = (rule, detail) => out.push({ rule, detail });
  const title = String(v.title ?? '').trim(), desc = String(v.description ?? '');
  if (!title) bad('title_missing', 'a title is required'); else if (title.length > 100) bad('title_too_long', `${title.length} > 100`);
  if (!Number.isFinite(v.duration_s) || v.duration_s <= 0) bad('duration_missing', 'duration_s must be a positive number');
  else if (v.duration_s > max_seconds) bad('too_long', `${v.duration_s}s exceeds ${max_seconds}s`);
  if (!/^[0-9a-f]{64}$/.test(String(v.asset_sha256 ?? ''))) bad('asset_hash_missing', 'asset_sha256 must be a 64-character hex digest');
  if (!String(v.asset_ref ?? '').trim()) bad('asset_ref_missing', 'asset_ref is required');
  const p = v.provenance;
  if (!p || typeof p !== 'object') bad('provenance_missing', 'a provenance record is required');
  else {
    if (!String(p.generator ?? '').trim()) bad('provenance_generator_missing', 'say what made the video');
    if (typeof p.synthetic !== 'boolean') bad('provenance_synthetic_missing', 'synthetic must be true or false');
    if (!p.created_at || Number.isNaN(Date.parse(p.created_at))) bad('provenance_date_missing', 'created_at must be a date');
    if (!Array.isArray(p.sources) || !p.sources.length) bad('provenance_sources_missing', 'cite at least one claim id');
    else {
      const byId = new Map(claims.map(c => [c.id, c]));
      for (const id of p.sources) {
        const c = byId.get(id);
        const age = c && c.last_checked_at ? now - parseIso(c.last_checked_at) : Infinity;
        if (!c) bad('unknown_claim', id);
        else if (!c.public || c.last_result !== 'pass') bad('claim_not_public_passing', id);
        else if (age > (c.max_age_hours ?? 24) * 3600e3) bad('claim_stale', id);
      }
    }
    if (p.synthetic === true && !desc.toLowerCase().includes(String(disclosure).toLowerCase())) bad('disclosure_missing', `synthetic media needs the label "${disclosure}" in the description`);
  }
  for (const m of `${title} ${desc}`.match(URL_RE) || []) {
    let host; try { host = new URL(/^https?:/i.test(m) ? m : `https://${m}`).hostname; } catch { bad('url_invalid', m); continue; }
    if (/^http:/i.test(m)) bad('url_not_https', m);
    if (!hostAllowed(host, allowlist)) bad('url_not_allowed', host);
  }
  return { ok: out.length === 0, violations: out };
}
