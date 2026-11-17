// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// core/ownerlink: the owner action register (OWNERLINK-1). One row per thing only the owner can do, each with exactly one link.
// flowFor() picks the one-click flow that can obtain a capability; no flow means the ask is refused (see the card guard trigger).
const iso = ctx => new Date(ctx.now()).toISOString();
const rid = () => [...globalThis.crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('');

/** Flows are plain data: { id, title, matches(capability, subject) }. Handlers live in index.js. */
export const FLOW_MATCHERS = [
  { id: 'github_app', title: 'Connect GitHub', matches: (c, s) => c.startsWith('github.') || (c === 'secret.available' && /^(VCS_TOKEN|GITHUB_)/.test(s)) },
  { id: 'mastodon', title: 'Connect Mastodon', matches: (c, s) => c === 'secret.available' && /^MASTODON_/.test(s) },
  { id: 'bluesky', title: 'Connect Bluesky', matches: (c, s) => c === 'secret.available' && /^BLUESKY_/.test(s) },
];
export const flowFor = (capability, subject, extra = []) => [...extra, ...FLOW_MATCHERS].find(f => f.matches(capability, subject)) || null;

export const origin = ctx => String(ctx.config?.ownerlink?.origin || '').replace(/\/+$/, '');
export const goLink = (ctx, id) => `${origin(ctx)}/owner/go/${encodeURIComponent(id)}`;

/** Create or refresh an action. Returns the row. Idempotent on id. */
export async function putAction(ctx, a) {
  for (const k of ['id', 'flow', 'title']) if (!a[k]) throw new Error(`ownerlink: action needs ${k}`);
  const link = a.link || goLink(ctx, a.id);
  await ctx.db.prepare(`INSERT INTO ownerlink_actions (id, card_id, flow, title, why, subject, link, extra_link, extra_label, status, created_at, detail) VALUES (?,?,?,?,?,?,?,?,?,'open',?,?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, why = excluded.why, link = excluded.link, extra_link = excluded.extra_link, extra_label = excluded.extra_label,
      status = CASE WHEN ownerlink_actions.status = 'dismissed' THEN 'dismissed' ELSE 'open' END, done_at = NULL`)
    .bind(a.id, a.card_id || null, a.flow, a.title, a.why || '', a.subject || '', link, a.extra_link || null, a.extra_label || null, iso(ctx), JSON.stringify(a.detail || {})).run();
  return ctx.db.prepare('SELECT * FROM ownerlink_actions WHERE id = ?').bind(a.id).first();
}

export async function complete(ctx, id) {
  const row = await ctx.db.prepare('SELECT card_id FROM ownerlink_actions WHERE id = ?').bind(id).first();
  await ctx.db.prepare(`UPDATE ownerlink_actions SET status = 'done', done_at = ? WHERE id = ? AND status = 'open'`).bind(iso(ctx), id).run();
  if (row?.card_id) await ctx.db.prepare(`UPDATE gate_cards SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'`).bind(iso(ctx), row.card_id).run();
}

export const openActions = ctx => ctx.db.prepare(`SELECT * FROM ownerlink_actions WHERE status = 'open' ORDER BY created_at, id`).all().then(r => r.results || []);
export const recentDone = ctx => ctx.db.prepare(`SELECT * FROM ownerlink_actions WHERE status = 'done' ORDER BY done_at DESC LIMIT 10`).all().then(r => r.results || []);

/** For an access ask: the action that carries its link, or null when no flow can obtain it (the ask is then refused). */
export async function actionForAsk(ctx, g) {
  const flow = flowFor(g.capability, g.subject, ctx.config?.ownerlink?.flows || []);
  if (!flow) return null;
  const sub = ctx.config?.ownerlink?.signup?.[flow.id] || null;
  return putAction(ctx, { id: g.id, card_id: g.id, flow: flow.id, title: flow.title, why: g.what, subject: g.subject, extra_link: sub, extra_label: sub ? 'No account yet? Sign up first' : null });
}

export async function newState(ctx, actionId, flow, data, minutes = 15) {
  const state = rid();
  await ctx.db.prepare('INSERT INTO ownerlink_state (state, action_id, flow, data, expires_at) VALUES (?,?,?,?,?)').bind(state, actionId, flow, JSON.stringify(data || {}), new Date(ctx.now() + minutes * 60000).toISOString()).run();
  return state;
}
export async function takeState(ctx, state, flow) {
  const r = await ctx.db.prepare('SELECT * FROM ownerlink_state WHERE state = ? AND flow = ?').bind(String(state || ''), flow).first();
  if (!r) return null;
  await ctx.db.prepare('DELETE FROM ownerlink_state WHERE state = ?').bind(r.state).run();
  return r.expires_at >= iso(ctx) ? { ...r, data: JSON.parse(r.data) } : null;
}
