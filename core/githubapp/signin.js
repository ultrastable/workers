// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// OWNER-AUTH-1 piece (b): "Sign in with GitHub" through the installed GitHub App. The role is read from the repository the organization
// was started from (config.vcs.repo), never typed. Routes: /console/github/signin and /console/github/signin/callback.
import { roleFor, issueSession } from '../auth/index.js';

export const SESSION_COOKIE = 'us_session';
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const html = (body, status = 200, headers = {}) => new Response('<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body style="font:16px system-ui;max-width:30rem;margin:4rem auto;padding:0 1rem">' + body,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
const cookie = (req, n) => (req.headers.get('cookie') || '').split(/;\s*/).map(p => p.split('=')).find(([k]) => k === n)?.[1];

/** The session key is generated here the first time it is needed and kept in the vault; nobody sets it. */
async function sessionKey(vault) {
  let k = await vault.read('SESSION_KEY');
  if (!k) { k = hex(crypto.getRandomValues(new Uint8Array(32))); await vault.put('SESSION_KEY', k, { by: 'signin' }); }
  return k;
}

export function createSignin({ vault, fetch, repo, now = () => Date.now(), apiBase = 'https://api.github.com' }) {
  const doFetch = fetch || ((...a) => globalThis.fetch(...a));
  const clock = typeof now === 'function' ? now : () => now;
  const gh = (path, token) => doFetch(apiBase + path, { headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + token, 'x-github-api-version': '2022-11-28', 'user-agent': 'ultrastable-signin' } });

  return async function handle(request) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '');
    if (request.method !== 'GET') return html('<h1>Not allowed</h1>', 405);
    if (p === '/console/github/signin') {
      const clientId = await vault.read('GITHUB_APP_CLIENT_ID');
      if (!clientId) return html('<h1>Not connected yet</h1><p>GitHub has not been connected to this installation, so there is nothing to sign in with.</p>', 409);
      const state = hex(crypto.getRandomValues(new Uint8Array(16)));
      const auth = 'https://github.com/login/oauth/authorize?' + new URLSearchParams({ client_id: clientId, redirect_uri: url.origin + '/console/github/signin/callback', state });
      return new Response(null, { status: 302, headers: { location: auth, 'cache-control': 'no-store', 'set-cookie': `us_signin_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/console/github; Max-Age=600` } });
    }
    if (p === '/console/github/signin/callback') {
      const code = url.searchParams.get('code') || '', state = url.searchParams.get('state') || '';
      if (!/^[A-Za-z0-9_-]{6,128}$/.test(code) || !state || state !== cookie(request, 'us_signin_state')) return html('<h1>That did not work</h1><p>The sign-in could not be matched to this browser. <a href="/console/github/signin">Try again</a>.</p>', 400);
      const clientId = await vault.read('GITHUB_APP_CLIENT_ID'), clientSecret = await vault.read('GITHUB_APP_CLIENT_SECRET');
      if (!clientId || !clientSecret) return html('<h1>Not connected yet</h1>', 409);
      let tok;
      try {
        const r = await doFetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'ultrastable-signin' }, body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }) });
        tok = (await r.json())?.access_token;
      } catch { return html('<h1>GitHub could not be reached</h1>', 502); }
      if (!tok) return html('<h1>GitHub refused the sign-in</h1><p><a href="/console/github/signin">Try again</a>.</p>', 400);
      const [u, rp] = await Promise.all([gh('/user', tok), gh('/repos/' + repo, tok)]);
      if (!u.ok) return html('<h1>GitHub did not say who you are</h1>', 502);
      const login = (await u.json())?.login;
      const permission = rp.ok ? ((await rp.json())?.permissions?.admin ? 'admin' : 'other') : 'none'; // no access to the repository: a viewer
      if (!login) return html('<h1>GitHub did not say who you are</h1>', 502);
      const session = await issueSession({ login, role: roleFor({ permission }), key: await sessionKey(vault), now: clock() });
      return new Response(null, { status: 303, headers: { location: '/console', 'cache-control': 'no-store', 'set-cookie': [`${SESSION_COOKIE}=${session}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800`] } });
    }
    return html('<h1>Not found</h1>', 404);
  };
}
