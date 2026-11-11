// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// One-click GitHub access (US-SPEC-18 door github-app-install). A GitHub App is created from a manifest, installed on
// the organization, and issues short-lived installation tokens, so nobody pastes a personal access token.
// Ports: vault (put/read/has), fetch, now (ms). Secrets go to the vault and are never echoed, logged, or stored elsewhere.
// The state value is a signed, expiring nonce bound to the browser by a cookie (no table needed); it is single use
// within one isolate and expires after 15 minutes everywhere.
import { signJwt } from './jwt.js';
export { signJwt } from './jwt.js';

const API = 'https://api.github.com';
const COOKIE = 'us_console';
const STATE_COOKIE = 'us_gh_state';
const STATE_TTL_MS = 15 * 60e3;
const REFRESH_MARGIN_MS = 5 * 60e3;
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// The vault refuses values shorter than 8 characters, so numeric ids are stored with a label.
const packId = (label, n) => `${label}:${n}`;
const unpackId = v => (v == null ? null : String(v).replace(/^[a-z-]+:/, ''));

/** The App manifest: the least the runner needs. No admin, no workflows unless config.workflows is true, no webhook. */
export function manifest(config = {}) {
  const base = String(config.baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('githubapp: config.baseUrl is required');
  const perms = { contents: 'write', pull_requests: 'write', issues: 'write', checks: 'read', metadata: 'read' };
  if (config.workflows === true) perms.workflows = 'write';
  return {
    name: config.appName || 'Ultrastable Runner',
    url: base,
    hook_attributes: { url: base + '/console/github/webhook', active: false },
    redirect_url: base + '/console/github/callback',
    setup_url: base + '/console/github/installed',
    setup_on_update: true,
    public: false,
    default_permissions: perms,
    default_events: [],
  };
}

async function hmac(key, text) {
  const k = await crypto.subtle.importKey('raw', enc.encode('github-app-state:' + key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(text)));
}
async function digest(s) { return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function same(a, b) {
  const [x, y] = await Promise.all([digest(String(a || '')), digest(String(b))]);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
function cookie(req, name) { return (req.headers.get('cookie') || '').split(/;\s*/).map(p => p.split('=')).find(([k]) => k === name)?.[1]; }

/** Same session check the console uses: the console cookie carries the access key. Default-deny without a token. */
export async function isConsoleAuthed(request, consoleToken) {
  if (!consoleToken) return false;
  let given = cookie(request, COOKIE) || '';
  try { given = decodeURIComponent(given); } catch { return false; }
  return same(given, consoleToken);
}

const page = (body, status = 200, extra = {}) => new Response(
  `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Connect GitHub</title><body style="font:16px system-ui;max-width:30rem;margin:4rem auto;padding:0 1rem">${body}`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; base-uri 'none'", ...extra } });
const denied = () => page('<h1>Sign in first</h1><p><a href="/console">Open the console</a></p>', 401);
const failed = (msg, status = 400) => page(`<h1>That did not work</h1><p>${msg} <a href="/console/github/connect">Try again</a>.</p>`, status);

/** True when the vault holds a complete App credential set. */
export async function hasAppCredentials(vault) {
  return Boolean(await vault.has('GITHUB_APP_ID') && await vault.has('GITHUB_APP_PRIVATE_KEY') && await vault.has('GITHUB_APP_INSTALLATION_ID'));
}

/** A connection entry for the console Connect page and the Needs-you card. */
export async function githubConnection(vault) {
  return { name: 'github', label: 'Connect GitHub', href: '/console/github/connect', present: await hasAppCredentials(vault) };
}

/** An async getToken() that returns an installation token, cached until 5 minutes before it expires. */
export function createInstallationTokenProvider({ vault, fetch, now = () => Date.now(), apiBase = API }) {
  const clock = typeof now === 'function' ? now : () => now;
  const doFetch = fetch || ((...a) => globalThis.fetch(...a));
  let cached = null; // memory only; never written to a table or a log
  let inflight = null;
  async function mint() {
    const appId = unpackId(await vault.read('GITHUB_APP_ID'));
    const pem = await vault.read('GITHUB_APP_PRIVATE_KEY');
    const inst = unpackId(await vault.read('GITHUB_APP_INSTALLATION_ID'));
    if (!appId || !pem || !inst) throw new Error('githubapp: app credentials are not complete in the vault');
    const jwt = await signJwt({ appId, pem, now: clock() });
    let res;
    try {
      res = await doFetch(`${apiBase}/app/installations/${encodeURIComponent(inst)}/access_tokens`, {
        method: 'POST', headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + jwt, 'x-github-api-version': '2022-11-28', 'user-agent': 'ultrastable-runner' },
      });
    } catch { throw new Error('githubapp: network error while requesting an installation token'); }
    if (!res.ok) throw new Error(`githubapp: installation token request failed: http ${res.status}`);
    const j = await res.json();
    if (!j?.token) throw new Error('githubapp: installation token response had no token');
    cached = { token: j.token, expiresAt: Date.parse(j.expires_at) || clock() + 55 * 60e3 };
    return cached.token;
  }
  return async function getToken() {
    if (cached && clock() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;
    inflight ||= mint().finally(() => { inflight = null; });
    return inflight;
  };
}

/** Route /console/github/*. Returns null for any other path. config: { baseUrl, org, appName, workflows }. */
export function createGithubApp({ vault, fetch, now = () => Date.now(), config = {}, consoleToken, apiBase = API }) {
  const clock = typeof now === 'function' ? now : () => now;
  const doFetch = fetch || ((...a) => globalThis.fetch(...a));
  const used = new Set();

  async function makeState() {
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    const exp = clock() + STATE_TTL_MS;
    return `${nonce}.${exp}.${await hmac(consoleToken, nonce + '.' + exp)}`;
  }
  async function checkState(state, bound) {
    const [nonce, exp, sig] = String(state || '').split('.');
    if (!nonce || !exp || !sig || !bound) return false;
    if (!(await same(sig, await hmac(consoleToken, nonce + '.' + exp)))) return false;
    if (clock() > Number(exp) || used.has(nonce) || bound !== nonce) return false;
    used.add(nonce);
    return true;
  }

  async function connect(origin) {
    const state = await makeState();
    const org = config.org ? `/organizations/${encodeURIComponent(config.org)}` : '';
    const action = `https://github.com${org}/settings/apps/new?state=${encodeURIComponent(state)}`;
    const m = esc(JSON.stringify(manifest({ ...config, baseUrl: config.baseUrl || origin })));
    const connected = await hasAppCredentials(vault);
    return page(`<h1 style="font-size:1.3rem">Connect GitHub</h1>${connected ? '<p>Already connected. You can connect again to replace it.</p>' : ''}
<p>One click. GitHub will ask you to confirm the app, then to install it.</p>
<form method=post action="${esc(action)}"><input type=hidden name=manifest value="${m}"><button style="padding:.7rem 1.2rem;font-size:1rem">Connect GitHub</button></form>`,
      200, { 'set-cookie': `${STATE_COOKIE}=${state.split('.')[0]}; HttpOnly; Secure; SameSite=Lax; Path=/console/github; Max-Age=900` });
  }

  async function callback(url, request) {
    const code = url.searchParams.get('code') || '';
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(code)) return failed('The link from GitHub was incomplete.');
    if (!(await checkState(url.searchParams.get('state'), cookie(request, STATE_COOKIE)))) return failed('The request could not be matched to this session, or it expired.');
    let res;
    try { res = await doFetch(`${apiBase}/app-manifests/${code}/conversions`, { method: 'POST', headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'ultrastable-runner' } }); }
    catch { return failed('GitHub could not be reached.', 502); }
    if (!res.ok) return failed(`GitHub refused the code (http ${res.status}).`, 502);
    const j = await res.json().catch(() => null);
    if (!j?.id || !j?.pem) return failed('GitHub sent an unexpected answer.', 502);
    const by = 'github-app';
    const r1 = await vault.put('GITHUB_APP_ID', packId('app-id', j.id), { by });
    const r2 = await vault.put('GITHUB_APP_PRIVATE_KEY', j.pem, { by });
    if (j.webhook_secret) await vault.put('GITHUB_APP_WEBHOOK_SECRET', j.webhook_secret, { by });
    if (r1.error || r2.error) return failed('The credentials could not be stored.', 500);
    const slug = String(j.slug || '').replace(/[^A-Za-z0-9-]/g, '');
    const install = slug ? `https://github.com/apps/${slug}/installations/new` : 'https://github.com/settings/apps';
    return new Response(null, { status: 303, headers: { location: install, 'cache-control': 'no-store', 'set-cookie': `${STATE_COOKIE}=; Path=/console/github; Max-Age=0` } });
  }

  async function installed(url) {
    const id = url.searchParams.get('installation_id') || '';
    if (!/^\d{1,15}$/.test(id)) return failed('GitHub did not say which installation.');
    const r = await vault.put('GITHUB_APP_INSTALLATION_ID', packId('installation-id', id), { by: 'github-app' });
    if (r.error) return failed('The installation could not be stored.', 500);
    return page('<h1 style="font-size:1.3rem">Connected</h1><p>GitHub is connected. Nothing else to paste.</p><p><a href="/console">Back to the console</a></p>');
  }

  return async function handle(request) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '');
    if (!p.startsWith('/console/github/')) return null;
    if (!(await isConsoleAuthed(request, consoleToken))) return denied();
    if (request.method !== 'GET') return page('<h1>Not allowed</h1>', 405);
    if (p === '/console/github/connect') return connect(url.origin);
    if (p === '/console/github/callback') return callback(url, request);
    if (p === '/console/github/installed') return installed(url);
    return page('<h1>Not found</h1>', 404);
  };
}
