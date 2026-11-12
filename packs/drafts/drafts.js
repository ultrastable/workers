// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Draft storage: create, revise, take, close. Every stored body carries the banner; nothing here sends anything.
import { all, first, run, iso } from '../../core/kernel/util.js';

export const BANNER = 'DRAFT, NOT FINAL. Not legal, patent or financial advice. Not signed, sent or used anywhere. Have a qualified professional review it before any use.';
const SECRET = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, /\bAKIA[0-9A-Z]{16}\b/, /\b(api[_-]?key|secret|password|token)\s*[:=]\s*['"]?[A-Za-z0-9\/+_.-]{12,}/i];
export const SECTIONS = {
  plan: ['Goal', 'Steps', 'Risks'],
  patent: ['Title', 'Field', 'Description', 'Embodiments'],
  legal: ['Parties', 'Terms', 'Open questions'],
};
// A draft may not present itself as final, as advice, or as already used.
const OVERCLAIM = [
  [/\b(this is|constitutes|provides?)\s+(legal|patent|financial)\s+advice\b/i, 'claims_advice'],
  [/\b(is|are)\s+(legally\s+)?(binding|enforceable|valid|final)\b/i, 'claims_final'],
  [/\b(has|have)\s+been\s+(filed|signed|submitted|executed|sent)\b/i, 'claims_used'],
  [/\bready\s+to\s+(file|sign|submit|send)\b/i, 'claims_ready'],
];

const stripBanner = b => String(b).startsWith(BANNER) ? String(b).slice(BANNER.length).replace(/^\s+/, '') : String(b);
export const stamp = body => `${BANNER}\n\n${stripBanner(body)}`;
const sha256 = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(x => x.toString(16).padStart(2, '0')).join('');

export function checkDraft({ kind, title, body }) {
  const v = [];
  if (!SECTIONS[kind]) v.push({ rule: 'kind_unknown', detail: String(kind) });
  if (!String(title ?? '').trim()) v.push({ rule: 'title_missing', detail: 'a title is required' });
  const text = stripBanner(body ?? '');
  if (!text.trim()) v.push({ rule: 'body_empty', detail: 'the draft has no text' });
  for (const sec of SECTIONS[kind] || []) {
    if (!new RegExp(`^\\s*#{1,4}\\s*${sec}\\b|^\\s*${sec}\\s*:`, 'im').test(text)) v.push({ rule: 'section_missing', detail: sec });
  }
  for (const [re, rule] of OVERCLAIM) if (re.test(text)) v.push({ rule, detail: text.match(re)[0] });
  if (SECRET.some(re => re.test(text))) v.push({ rule: 'secret_pattern', detail: 'a secret-shaped value is in the text' });
  return { ok: v.length === 0, violations: v };
}

export async function createDraft({ db, now = Date.now, kind, title, body, author = 'pack', idempotencyKey = null }) {
  if (idempotencyKey) {
    const ex = await first(db, `SELECT id FROM drafts_items WHERE idem_key = ?`, idempotencyKey);
    if (ex) return { created: false, duplicate: true, id: ex.id };
  }
  const res = checkDraft({ kind, title, body });
  if (!res.ok) {
    await run(db, `INSERT INTO drafts_rejections (at, kind, title, violations) VALUES (?,?,?,?)`, iso(now()), kind ?? null, String(title ?? '').slice(0, 200), JSON.stringify(res.violations));
    return { created: false, violations: res.violations };
  }
  const t = iso(now()), stamped = stamp(body);
  const r = await run(db, `INSERT INTO drafts_items (idem_key, kind, title, created_at, updated_at) VALUES (?,?,?,?,?)`, idempotencyKey, kind, title.trim(), t, t);
  const id = r.meta.last_row_id;
  await run(db, `INSERT INTO drafts_versions (draft_id, version, body, body_sha256, author, created_at) VALUES (?,?,?,?,?,?)`, id, 1, stamped, await sha256(stamped), author, t);
  return { created: true, id, version: 1 };
}

export async function reviseDraft({ db, now = Date.now, id, body, author = 'pack' }) {
  const d = await first(db, `SELECT * FROM drafts_items WHERE id = ?`, id);
  if (!d) return { revised: false, reason: 'not_found' };
  if (d.status !== 'draft') return { revised: false, reason: `status_${d.status}` };
  const res = checkDraft({ kind: d.kind, title: d.title, body });
  if (!res.ok) {
    await run(db, `INSERT INTO drafts_rejections (at, kind, title, violations) VALUES (?,?,?,?)`, iso(now()), d.kind, d.title, JSON.stringify(res.violations));
    return { revised: false, violations: res.violations };
  }
  const stamped = stamp(body), hash = await sha256(stamped);
  const last = await first(db, `SELECT body_sha256 FROM drafts_versions WHERE draft_id = ? AND version = ?`, id, d.version);
  if (last && last.body_sha256 === hash) return { revised: false, reason: 'unchanged', version: d.version };
  const v = d.version + 1, t = iso(now());
  await run(db, `INSERT INTO drafts_versions (draft_id, version, body, body_sha256, author, created_at) VALUES (?,?,?,?,?,?)`, id, v, stamped, hash, author, t);
  await run(db, `UPDATE drafts_items SET version = ?, updated_at = ? WHERE id = ?`, v, t, id);
  return { revised: true, version: v };
}

// Only a person's own act: records that they took the draft elsewhere. The pack itself never marks a draft used.
export async function markTaken({ db, now = Date.now, id, by }) {
  if (!String(by ?? '').trim()) return { ok: false, reason: 'by_required' };
  const r = await run(db, `UPDATE drafts_items SET status = 'taken', taken_by = ?, updated_at = ? WHERE id = ? AND status = 'draft'`, by, iso(now()), id);
  return { ok: (r.meta.changes ?? 0) === 1 };
}
export async function closeDraft({ db, now = Date.now, id }) {
  const r = await run(db, `UPDATE drafts_items SET status = 'closed', updated_at = ? WHERE id = ? AND status = 'draft'`, iso(now()), id);
  return { ok: (r.meta.changes ?? 0) === 1 };
}
export const getDraft = async ({ db, id }) => {
  const d = await first(db, `SELECT * FROM drafts_items WHERE id = ?`, id);
  return d && { ...d, body: (await first(db, `SELECT body FROM drafts_versions WHERE draft_id = ? AND version = ?`, id, d.version)).body };
};
export const listDrafts = ({ db, status = 'draft' }) => all(db, `SELECT id, kind, title, status, version, updated_at FROM drafts_items WHERE status = ? ORDER BY id`, status);
