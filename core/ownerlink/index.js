// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// core/ownerlink (OWNERLINK-1): the owner action page. Whatever only the owner can do is one button on /owner. The owner signs in
// (GitHub App session or Cloudflare Access), clicks, and a standards-based flow (OAuth 2.0, atproto OAuth, a review page) does the rest;
// callbacks store results in the vault. Nobody copies a value. Tenant-agnostic: instances, repositories and origin come from config.ownerlink.
// Ports: { db, vault, fetch, now, config, env, doors? }.
import { readSession, canWrite } from '../auth/index.js';
import { verifyAccessJwt } from '../doors/index.js';
import { openActions, recentDone, complete, goLink } from './actions.js';
import * as mastodon from './mastodon.js';
import * as bluesky from './atproto.js';
import { syncPullRequests } from './prs.js';
export { actionForAsk, putAction, flowFor, goLink } from './actions.js';
export { createBlueskyClient } from './atproto.js';
export { syncPullRequests };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SECURE = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'" };
const CSS = ':root{color-scheme:light dark;--bg:#fff;--fg:#14171a;--mut:#58636e;--ln:#d6dbe0;--ac:#0b5cff;--acfg:#fff}@media(prefers-color-scheme:dark){:root{--bg:#101316;--fg:#eef1f4;--mut:#9aa6b2;--ln:#2a3138;--ac:#6ea0ff;--acfg:#0a0f1a}}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}main{max-width:36rem;margin:0 auto;padding:1.5rem 1rem 4rem}h1{font-size:1.4rem;margin:0 0 .25rem}h2{font-size:1rem;margin:2rem 0 .5rem;color:var(--mut)}p{margin:.25rem 0}.mut{color:var(--mut);font-size:.9rem}.card{border:1px solid var(--ln);border-radius:12px;padding:1rem;margin:.75rem 0}.btn{display:block;box-sizing:border-box;min-height:44px;line-height:44px;margin-top:.75rem;border-radius:10px;background:var(--ac);color:var(--acfg);text-align:center;text-decoration:none;font-weight:600}.alt{display:inline-block;min-height:44px;line-height:44px;color:var(--ac)}a:focus-visible{outline:3px solid var(--ac);outline-offset:2px}';
const page = (title, body, status = 200, headers = {}) => new Response(`<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style><main>${body}</main></html>`, { status, headers: { ...SECURE, ...headers } });
const redirect = (to, headers = {}) => new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store', ...headers } });
const cookie = (req, n) => (req.headers.get('cookie') || '').split(/;\s*/).map(p => p.split('=')).find(([k]) => k === n)?.[1];
const json = (o, status = 200) => Response.json(o, { status, headers: { 'cache-control': 'no-store' } });
const FLOWS = { mastodon, bluesky };

export function createOwnerlink(ctx) {
  const clock = typeof ctx.now === 'function' ? ctx.now : () => ctx.now;
  const h = { ...ctx, now: clock };

  async function authed(request) {
    const jwt = request.headers.get('cf-access-jwt-assertion'), acc = ctx.doors?.access;
    if (jwt && acc?.team_domain && acc?.aud && await verifyAccessJwt(jwt, { team_domain: acc.team_domain, aud: acc.aud, fetch: ctx.fetch, now: clock() })) return { via: 'access' };
    const s = await readSession(decodeURIComponent(cookie(request, 'us_session') || ''), { key: await ctx.vault.read('SESSION_KEY'), now: clock() });
    return canWrite(s) ? { via: 'github', login: s.login } : null;
  }

  async function signinPage(origin) {
    const gh = await ctx.vault.read('GITHUB_APP_CLIENT_ID');
    return page('Owner actions', `<h1>Owner actions</h1><p class=mut>Sign in once. Everything after that is one click.</p>` +
      (gh ? `<a class=btn href="/owner/signin">Sign in with GitHub</a>` : `<p class=card>GitHub is not connected to this installation yet, so there is nothing to sign in with. The connection link is <a href="/console/github/connect">here</a>.</p>`), 401);
  }

  async function listPage() {
    const open = await openActions(h), done = await recentDone(h);
    const card = a => { const d = JSON.parse(a.detail || '{}'); void d; return `<div class=card><strong>${esc(a.title)}</strong>${a.why ? `<p class=mut>${esc(a.why)}</p>` : ''}<a class=btn href="${esc(a.link)}">${a.flow === 'pr_review' ? 'Open the review page' : 'Do it in one click'}</a>${a.extra_link ? `<a class=alt href="${esc(a.extra_link)}" rel="noopener">${esc(a.extra_label || 'More')}</a>` : ''}</div>`; };
    return page('Owner actions', `<h1>Owner actions</h1><p class=mut>${open.length ? `${open.length} waiting. Each is one button.` : 'Nothing is waiting on you.'}</p>${open.map(card).join('')}` +
      (done.length ? `<h2>Done lately</h2>${done.map(a => `<p class=mut>${esc(a.title)}</p>`).join('')}` : ''));
  }

  async function go(request, url, id) {
    const a = await ctx.db.prepare(`SELECT * FROM ownerlink_actions WHERE id = ? AND status = 'open'`).bind(id).first();
    if (!a) return page('Owner actions', '<h1>Already done</h1><p><a class=alt href="/owner">Back to the list</a></p>', 404);
    a.detail = JSON.parse(a.detail || '{}');
    if (a.flow === 'pr_review') return redirect(a.link);
    if (a.flow === 'github_app') return redirect('/console/github/connect');
    const f = FLOWS[a.flow]; if (!f) return page('Owner actions', '<h1>No flow</h1>', 404);
    const r = await f.start(h, a, url.origin).catch(e => ({ error: String(e?.message || e).slice(0, 200) }));
    if (r.error) return page('Owner actions', `<h1>That did not work</h1><p>${esc(r.error)}</p><p><a class=alt href="/owner">Back to the list</a></p>`, 502);
    return redirect(r.redirect, { 'set-cookie': `us_owner_state=${r.state}; HttpOnly; Secure; SameSite=Lax; Path=/owner; Max-Age=900` });
  }

  async function callback(request, url, provider) {
    const f = FLOWS[provider]; if (!f) return page('Owner actions', '<h1>Not found</h1>', 404);
    const state = url.searchParams.get('state');
    if (!state || state !== cookie(request, 'us_owner_state')) return page('Owner actions', '<h1>That did not work</h1><p>The answer could not be matched to this browser. <a class=alt href="/owner">Start again</a>.</p>', 400);
    const r = await f.callback(h, url, url.origin).catch(e => ({ error: String(e?.message || e).slice(0, 200) }));
    const clear = { 'set-cookie': 'us_owner_state=; HttpOnly; Secure; SameSite=Lax; Path=/owner; Max-Age=0' };
    return r.error ? page('Owner actions', `<h1>That did not work</h1><p>${esc(r.error)}</p><p><a class=alt href="/owner">Back to the list</a></p>`, 400, clear)
      : page('Owner actions', `<h1>Done</h1><p>${esc(r.ok)}</p><p><a class=alt href="/owner">Back to the list</a></p>`, 200, clear);
  }

  async function handle(request) {
    const url = new URL(request.url), p = url.pathname.replace(/\/+$/, '') || '/';
    if (!(p === '/owner' || p.startsWith('/owner/') || p === '/api/owner/actions')) return null;
    if (request.method !== 'GET') return page('Owner actions', '<h1>Not allowed</h1>', 405);
    if (p === '/owner/atproto/client-metadata.json') return json(bluesky.clientMetadata(url.origin));
    if (p === '/owner/signin') return redirect('/console/github/signin', { 'set-cookie': 'us_return=/owner; HttpOnly; Secure; SameSite=Lax; Path=/console/github; Max-Age=600' });
    if (!(await authed(request))) return p === '/api/owner/actions' ? json({ error: 'sign_in_required', sign_in: url.origin + '/owner/signin' }, 401) : signinPage(url.origin);
    if (p === '/owner') return listPage();
    if (p === '/api/owner/actions') return json({ actions: (await openActions(h)).map(a => ({ id: a.id, flow: a.flow, title: a.title, link: a.link, extra_link: a.extra_link })) });
    let m;
    if ((m = p.match(/^\/owner\/go\/([^/]+)$/))) return go(request, url, decodeURIComponent(m[1]));
    if ((m = p.match(/^\/owner\/callback\/([a-z]+)$/))) return callback(request, url, m[1]);
    return page('Owner actions', '<h1>Not found</h1>', 404);
  }

  /** Tick step: waiting PRs become actions; an action whose card closed, or whose secret now exists, is done. */
  async function step() {
    const prs = await syncPullRequests(h).catch(e => ({ error: String(e?.message || e).slice(0, 100) }));
    let closed = 0;
    for (const a of await openActions(h)) {
      const card = a.card_id ? await ctx.db.prepare('SELECT status FROM gate_cards WHERE id = ?').bind(a.card_id).first() : null;
      const secret = a.flow === 'mastodon' ? 'MASTODON_TOKEN' : a.flow === 'bluesky' ? 'BLUESKY_OAUTH' : null;
      if ((card && card.status === 'closed') || (secret && await ctx.vault.has(secret))) { await complete(h, a.id); closed++; }
    }
    return { prs, closed };
  }

  return { handle, step, link: id => goLink(h, id) };
}
