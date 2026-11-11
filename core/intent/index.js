// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Intent intake: a request from any client becomes one work item the loops act on, or a recorded non-action.
// Verdicts: filed (new item), duplicate (same normalized request already filed), rejected (empty or too long), gated (identity-bound step: becomes a gate card).
// Ports: ctx = { db, now(), config }. Clients (chat, CLI, console, email) are thin callers of submit().
const DEFAULTS = { max_chars: 4000, owner_role: 'project-manager', gate_words: ['wire money', 'transfer funds', 'sign the', 'file the', 'delete all', 'send as'] };
export const cfg = ctx => ({ ...DEFAULTS, ...(ctx.config || {}) });
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
async function hash(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 24); }
const first = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()) || null;
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();

export async function submit(ctx, { client, text }) {
  const c = cfg(ctx), t = String(text || '').trim();
  const key = await hash(norm(t));
  const rec = (verdict, item, reason) => run(ctx.db, 'INSERT OR IGNORE INTO intent_requests (client,text,dedupe_key,verdict,item_id,reason) VALUES (?,?,?,?,?,?)', client || 'unknown', t.slice(0, c.max_chars), key + (verdict === 'filed' || verdict === 'gated' ? '' : ':' + Date.now() + Math.random()), verdict, item, reason);
  if (!t || t.length > c.max_chars) { await rec('rejected', null, !t ? 'empty' : 'too_long'); return { ok: false, verdict: 'rejected' }; }
  const dup = await first(ctx.db, 'SELECT item_id FROM intent_requests WHERE dedupe_key = ?', key);
  if (dup) { await rec('duplicate', dup.item_id, 'same request'); return { ok: true, verdict: 'duplicate', item_id: dup.item_id }; }
  const gated = c.gate_words.some(w => norm(t).includes(w));
  const id = 'INT-' + key.slice(0, 10);
  await run(ctx.db, "INSERT OR IGNORE INTO items (id,title,kind,owner_role,done_check,closing_probe,priority,status) VALUES (?,?,'work',?,?,?,50,?)",
    id, t.split('\n')[0].slice(0, 120), c.owner_role, t, 'request satisfied and verified by an independent check', gated ? 'blocked' : 'open');
  if (gated) await run(ctx.db, "UPDATE items SET blocker='identity-bound step: gate card opened', disposition=NULL WHERE id=?", id);
  await rec(gated ? 'gated' : 'filed', id, gated ? 'identity_bound' : null);
  return { ok: true, verdict: gated ? 'gated' : 'filed', item_id: id };
}
