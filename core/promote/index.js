// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Status of every piece is kept in core/promote/README.md.
// Promotion engine, tenant-agnostic. A tenant hands over entries it already described ({ id, title, url, summary, tags, label });
// the engine turns each into a short post per channel, labels it automated, and publishes within caps. Enforced in code:
//   - one kill switch (config.promote.halt or env.HALT='1') stops everything; a channel without its credentials is skipped, never faked
//   - idempotent: one post per (channel, entry, content hash); per-channel daily cap; links only to the tenant's own origin
//   - channel order and budget follow measured referrals per post (tune), with an exploration floor so no channel starves
//   - reach targets are metrics; evaluate() returns the breaches for the tenant's loop to file as items
// Ports: db, fetch, now, env (secrets by name only), config.promote. No tenant names here.
// A Worker's fetch must be called unbound from any object (`ctx.fetch(...)` as a method call throws Illegal invocation).
const F = ctx => { const f = ctx.fetch; return (...a) => f(...a); };
const iso = ctx => new Date((ctx.now || Date.now)()).toISOString();
const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…');

export const halted = ctx => !!(ctx.config?.promote?.halt) || ctx.env?.HALT === '1';
// IndexNow key: public by design (served at /<key>.txt), derived so no secret is needed.
export const indexnowKey = async tenant => (await sha('indexnow:' + tenant)).slice(0, 32);

const label = c => c.promote.automatedLabel || 'Automated post';
export function compose(channel, e, cfg, c) {
  const tags = (e.tags || []).slice(0, 2).map(t => '#' + String(t).replace(/[^A-Za-z0-9]/g, '')).filter(t => t.length > 1).join(' ');
  const lead = e.label ? `${e.title} (${e.label}).` : `${e.title}.`;
  const link = e.url, tail = `${label(c)}. ${tags}`.trim();
  const limit = { mastodon: 500, bluesky: 300 }[channel] || 280;
  const room = limit - link.length - tail.length - 4;
  return `${clip(`${lead} ${e.summary || ''}`.trim(), Math.max(room, 40))}\n${link}\n${tail}`;
}

const channels = {
  async indexnow(ctx, cfg, items) {
    const origin = new URL(ctx.config.promote.origin), key = cfg.key || await indexnowKey(ctx.config.promote.tenant);
    const r = await F(ctx)('https://api.indexnow.org/indexnow', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: origin.host, key, keyLocation: `${origin.origin}/${key}.txt`, urlList: items.map(i => i.entry.url) }) });
    if (!(r.status === 200 || r.status === 202)) throw new Error('indexnow HTTP ' + r.status);
  },
  async mastodon(ctx, cfg, [i]) {
    if (!ctx.env?.[cfg.tokenEnv || 'MASTODON_TOKEN']) throw Object.assign(new Error('credentials missing'), { skip: true });
    const r = await F(ctx)(cfg.base.replace(/\/+$/, '') + '/api/v1/statuses', { method: 'POST',
      headers: { authorization: 'Bearer ' + ctx.env[cfg.tokenEnv || 'MASTODON_TOKEN'], 'content-type': 'application/json', 'idempotency-key': i.idem },
      body: JSON.stringify({ status: i.text, visibility: 'public', language: cfg.language || 'en' }) });
    if (!r.ok) throw new Error('mastodon HTTP ' + r.status);
  },
  async bluesky(ctx, cfg, [i]) {
    const { BLUESKY_IDENTIFIER: id, BLUESKY_APP_PASSWORD: pw } = ctx.env || {};
    if (!id || !pw) throw Object.assign(new Error('credentials missing'), { skip: true });
    const base = (cfg.service || 'https://bsky.social').replace(/\/+$/, '');
    const s = await (await F(ctx)(base + '/xrpc/com.atproto.server.createSession', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: id, password: pw }) })).json();
    if (!s.accessJwt) throw new Error('bluesky login failed');
    const r = await F(ctx)(base + '/xrpc/com.atproto.repo.createRecord', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.accessJwt },
      body: JSON.stringify({ repo: s.did, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: i.text, createdAt: iso(ctx), langs: ['en'] } }) });
    if (!r.ok) throw new Error('bluesky HTTP ' + r.status);
  },
};
export const CHANNEL_IDS = Object.keys(channels);
const BATCH = new Set(['indexnow']);

export async function weights(ctx) {
  const { results } = await ctx.db.prepare('SELECT channel, weight FROM promote_weights WHERE tenant=?').bind(ctx.config.promote.tenant).all();
  return Object.fromEntries(results.map(r => [r.channel, r.weight]));
}
// Referrals per post per channel, with a prior of 1 post and 1 referral so a new channel is tried; weights floor at 0.1.
export async function tune(ctx) {
  const t = ctx.config.promote.tenant;
  const { results } = await ctx.db.prepare("SELECT channel, COUNT(*) AS posts, SUM(referrals) AS refs FROM promote_posts WHERE tenant=? AND status='sent' GROUP BY channel").bind(t).all();
  const out = {};
  for (const r of results) {
    const w = Math.max(0.1, ((r.refs || 0) + 1) / (r.posts + 1));
    out[r.channel] = w;
    await ctx.db.prepare('INSERT OR REPLACE INTO promote_weights (tenant, channel, weight, at) VALUES (?,?,?,?)').bind(t, r.channel, w, iso(ctx)).run();
  }
  return out;
}
export async function recordReferrals(ctx, idem, n) { await ctx.db.prepare('UPDATE promote_posts SET referrals=? WHERE idem=?').bind(n, idem).run(); }

export async function run(ctx, entries) {
  const c = ctx.config.promote, out = { halted: false, sent: [], skipped: [], failed: [] };
  if (halted(ctx)) return { ...out, halted: true };
  const w = await weights(ctx), day = iso(ctx).slice(0, 10);
  const order = Object.keys(c.channels || {}).filter(k => channels[k] && c.channels[k].enabled !== false).sort((a, b) => (w[b] ?? 1) - (w[a] ?? 1));
  for (const ch of order) {
    const cfg = c.channels[ch], used = (await ctx.db.prepare("SELECT COUNT(*) AS n FROM promote_posts WHERE tenant=? AND channel=? AND substr(at,1,10)=? AND status='sent'").bind(c.tenant, ch, day).first()).n;
    let room = Math.max(1, Math.round((cfg.perDay ?? 3) * Math.min(1, Math.max(0.34, w[ch] ?? 1)))) - used;
    const items = [];
    for (const e of entries) {
      const text = compose(ch, e, cfg, ctx.config), idem = `${ch}:${e.id}:${(await sha(text)).slice(0, 12)}`;
      if (await ctx.db.prepare("SELECT 1 AS x FROM promote_posts WHERE idem=? AND status='sent'").bind(idem).first()) continue;
      if (!BATCH.has(ch) && room <= 0) { out.skipped.push({ ch, id: e.id, why: 'daily cap' }); continue; }
      if (!String(e.url || '').startsWith(c.origin)) { out.skipped.push({ ch, id: e.id, why: 'foreign link' }); continue; }
      items.push({ entry: e, text, idem }); if (!BATCH.has(ch)) room--;
    }
    for (const group of BATCH.has(ch) ? (items.length ? [items] : []) : items.map(i => [i])) {
      let status = 'sent', detail = null;
      try { await channels[ch](ctx, cfg, group); } catch (err) { status = err.skip ? 'skipped' : 'failed'; detail = err.message; }
      for (const i of group) {
        if (status === 'skipped') { out.skipped.push({ ch, id: i.entry.id, why: detail }); continue; }
        await ctx.db.prepare('INSERT OR REPLACE INTO promote_posts (idem, tenant, channel, entry_id, text, status, detail, at) VALUES (?,?,?,?,?,?,?,?)').bind(i.idem, c.tenant, ch, i.entry.id, i.text, status, detail, iso(ctx)).run();
        (status === 'sent' ? out.sent : out.failed).push({ ch, id: i.entry.id, idem: i.idem });
      }
    }
  }
  return out;
}

// Reach and impact: metrics with explicit targets; breaches are returned for the loop to file as items with a probe.
export async function snapshot(ctx, metrics, day = iso(ctx).slice(0, 10)) {
  for (const [m, v] of Object.entries(metrics)) await ctx.db.prepare('INSERT OR REPLACE INTO promote_metrics (tenant, day, metric, value) VALUES (?,?,?,?)').bind(ctx.config.promote.tenant, day, m, v).run();
}
// targets: { metric: { min, windowDays } } e.g. { referrals: { min: 20, windowDays: 7 } }; the window value is the sum of daily snapshots.
export async function evaluate(ctx, targets) {
  const alerts = [], from = new Date((ctx.now || Date.now)() - 864e5 * 40).toISOString().slice(0, 10);
  for (const [metric, t] of Object.entries(targets)) {
    const since = new Date((ctx.now || Date.now)() - 864e5 * (t.windowDays - 1)).toISOString().slice(0, 10);
    const r = await ctx.db.prepare('SELECT COALESCE(SUM(value),0) AS v, COUNT(*) AS n FROM promote_metrics WHERE tenant=? AND metric=? AND day>=?').bind(ctx.config.promote.tenant, metric, since).first();
    if (r.v < t.min) alerts.push({ metric, target: t.min, value: r.v, windowDays: t.windowDays, measured_days: r.n, from });
  }
  return alerts;
}

// Owner idea intake: an issue labelled `idea` becomes a work item any agent can finish cold. The owner supplies nothing else.
export function ideaToItem(issue, { owner_role = 'product-manager' } = {}) {
  const body = String(issue.body || '').trim() || '(title only)';
  return {
    title: `Build: ${issue.title}`.slice(0, 120), labels: ['agent-ready', 'from-owner-idea'],
    body: `Source idea: #${issue.number} (owner)\n\n## Problem\n${body}\n\n## Owner role\n${owner_role}\n\n## Done check\nCode merged, tests pass, deployed, and a live probe (HTTP or D1 query) of the result passes.\n\n## Closing probe\nGET the deployed surface and assert the new behaviour; record the output in the PR.\n\n## Trigger\nNow. The agent decides scope, builds, merges, deploys and verifies without further input. Assumptions are stated in the PR.`,
  };
}
