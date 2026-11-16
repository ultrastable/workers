// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Outreach outbox for automated senders. Nothing leaves without a human approval and a transport; with no transport it only
// records what it would have sent (dry run). Enforced in code:
//   - sender identity (name, postal address, reply address) and the disclosure footer are required and always appended
//   - every intent cites an https evidence URL
//   - a suppressed address is never sent to; opting out is immediate and permanent
//   - per-day and per-recipient caps
// Ports: db (D1-style), now, and per call a transport({ to, subject, text, reply_to }). Tenants submit intents; they never reach the transport.
const norm = e => String(e || '').trim().toLowerCase();
const iso = ctx => new Date((ctx.now || Date.now)()).toISOString();

function need(ctx) {
  const s = ctx.config && ctx.config.sender;
  for (const k of ['name', 'postal', 'reply_to']) if (!s || !s[k]) throw new Error(`outreach: config.sender.${k} is required`);
  if (!ctx.config.footer) throw new Error('outreach: config.footer (disclosure) is required');
  return s;
}
export function render(ctx, i) {
  const s = need(ctx);
  return `${i.body}\n\n--\n${ctx.config.footer}\n${s.name}, ${s.postal}\nReplies reach a monitored inbox: ${s.reply_to}\nTo stop all messages from us, reply "stop" or write to that address; we will not contact you again.\nEvidence: ${i.evidence_url}`;
}
export async function submit(ctx, { tenant, id, to, subject, body, evidence_url }) {
  need(ctx);
  if (!tenant || !id || !to || !subject || !body) throw new Error('outreach: tenant, id, to, subject and body are required');
  if (!/^https:\/\//.test(evidence_url || '')) throw new Error('outreach: evidence_url (https) is required');
  const have = await ctx.db.prepare('SELECT * FROM outreach_intents WHERE id=?').bind(id).first();
  if (have) return have;
  const addr = norm(to);
  const sup = await ctx.db.prepare('SELECT 1 AS x FROM outreach_suppressed WHERE addr=?').bind(addr).first();
  const status = sup ? 'blocked_suppressed' : 'pending_approval';
  await ctx.db.prepare('INSERT INTO outreach_intents (id, tenant, to_addr, subject, body, evidence_url, status, created_at) VALUES (?,?,?,?,?,?,?,?)').bind(id, tenant, addr, subject, body, evidence_url, status, iso(ctx)).run();
  return { id, status };
}
export async function approve(ctx, id, by) {
  if (!by || /^agent:/.test(by)) throw new Error('outreach: approval must name a human');
  const r = await ctx.db.prepare("UPDATE outreach_intents SET status='approved', approved_by=? WHERE id=? AND status='pending_approval'").bind(by, id).run();
  return r.meta.changes === 1;
}
export async function suppress(ctx, address, why = 'opt-out') {
  const a = norm(address);
  await ctx.db.prepare('INSERT OR REPLACE INTO outreach_suppressed (addr, why, at) VALUES (?,?,?)').bind(a, why, iso(ctx)).run();
  await ctx.db.prepare("UPDATE outreach_intents SET status='blocked_suppressed' WHERE to_addr=? AND status IN ('pending_approval','approved')").bind(a).run();
}
export async function dispatch(ctx, { transport, limits = { perDay: 5, perRecipient: 2 } } = {}) {
  const out = [];
  const day = iso(ctx).slice(0, 10);
  const { results } = await ctx.db.prepare("SELECT * FROM outreach_intents WHERE status='approved' ORDER BY created_at, id").all();
  for (const i of results) {
    const today = (await ctx.db.prepare("SELECT COUNT(*) AS n FROM outreach_log WHERE substr(at,1,10)=? AND result IN ('sent','dry_run')").bind(day).first()).n;
    const prior = (await ctx.db.prepare("SELECT COUNT(*) AS n FROM outreach_log WHERE to_addr=? AND result IN ('sent','dry_run')").bind(i.to_addr).first()).n;
    const sup = await ctx.db.prepare('SELECT 1 AS x FROM outreach_suppressed WHERE addr=?').bind(i.to_addr).first();
    const why = sup ? 'suppressed' : today >= limits.perDay ? 'daily cap' : prior >= limits.perRecipient ? 'recipient cap' : null;
    if (why) { out.push({ id: i.id, result: 'skipped', why }); continue; }
    const text = render(ctx, i);
    const result = transport ? 'sent' : 'dry_run';
    if (transport) await transport({ to: i.to_addr, subject: i.subject, text, reply_to: ctx.config.sender.reply_to });
    const at = iso(ctx);
    await ctx.db.prepare('UPDATE outreach_intents SET status=?, sent_at=? WHERE id=?').bind(result, at, i.id).run();
    await ctx.db.prepare('INSERT INTO outreach_log (intent_id, to_addr, at, result, text) VALUES (?,?,?,?,?)').bind(i.id, i.to_addr, at, result, text).run();
    out.push({ id: i.id, result });
  }
  return out;
}
export async function stats(ctx, tenant) {
  const q = tenant ? ' WHERE tenant=?' : '';
  const st = ctx.db.prepare('SELECT status, COUNT(*) AS n FROM outreach_intents' + q + ' GROUP BY status');
  const { results } = await (tenant ? st.bind(tenant) : st).all();
  return { intents: Object.fromEntries(results.map(r => [r.status, r.n])), suppressed: (await ctx.db.prepare('SELECT COUNT(*) AS n FROM outreach_suppressed').first()).n };
}
