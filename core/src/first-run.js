// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The console's first-run door (US-SPEC-18/19, issue #87): the first visitor presses one button, gets a private access key
// shown once (only its hash is stored), and a Cloudflare Access sign-in door can replace it. No terminal, no secret to set.
import { firstRunState, claimFirstRun } from '../doors/index.js';

export const COOKIE = 'us_console';
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'";

export const page = (html, status = 200, extra = {}) => new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP, ...extra } });

export const SETUP = (inner, status = 200) => page(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body style="font:16px system-ui;max-width:30rem;margin:4rem auto;padding:0 1rem">${inner}`, status);
export const OFF = () => SETUP('<h1>Console is off</h1><p>Set the CONSOLE_TOKEN secret to turn it on. Until then nobody can open it.</p>', 503);
export const FIRST_RUN = () => SETUP(`<h1>Welcome</h1><p>Press the button to create your private access key. It will be shown once, on the next page. Only the first person to press it gets a key.</p>
<form method=post action=/console/first-run><button style="padding:.7rem 1.2rem;font-size:1rem">Create my key</button></form>`);

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const KEY_PAGE = key => SETUP(`<h1>Your access key</h1><p><b>This is shown once.</b> Copy it somewhere safe now. It cannot be shown again, and the system keeps only a fingerprint of it.</p>
<p><input id=k readonly value="${esc(key)}" style="width:100%;padding:.6rem;font:14px monospace"></p>
<p><button id=c style="padding:.6rem 1rem">Copy</button> <a href=/console>Open the console</a></p>
<script>document.getElementById('c').onclick=function(){var k=document.getElementById('k');k.select();(navigator.clipboard?navigator.clipboard.writeText(k.value):Promise.reject()).catch(function(){document.execCommand('copy')});this.textContent='Copied'}</script>`);

/** True when doors.access names a team domain and an audience (the Cloudflare Access sign-in door). */
export const accessConfigured = doors => Boolean(doors?.access?.team_domain && doors?.access?.aud);

/** Decide what the first-run door does for this request, when neither CONSOLE_TOKEN nor Access is configured.
 *  Returns { response } to send, or { issuedHash } when a key was already issued (the caller then checks keys against it). */
export async function firstRunDoor(request, env, { doors, now = Date.now() } = {}) {
  const url = new URL(request.url);
  const p = url.pathname;
  const api = p.startsWith('/api/');
  const fr = doors ? await firstRunState(env.DB, { now, minutes: doors.first_run_minutes ?? 60 }).catch(() => null) : null;
  if (fr?.state === 'issued') return { issuedHash: fr.hash };
  if (fr?.state === 'open') {
    if (request.method === 'POST' && p === '/console/first-run') {
      const origin = request.headers.get('origin');
      if (!origin || origin !== url.origin) return { response: Response.json({ error: 'cross-origin request refused' }, { status: 403 }) };
      const key = await claimFirstRun(env.DB);
      if (!key) return { response: SETUP('<h1>Already set up</h1><p>A key was already issued.</p>', 409) };
      const res = KEY_PAGE(key);
      res.headers.append('set-cookie', `${COOKIE}=${encodeURIComponent(key)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`);
      return { response: res };
    }
    if (request.method === 'GET' && (p === '/console' || p === '/console/')) return { response: FIRST_RUN() };
    return { response: api ? Response.json({ error: 'console not set up' }, { status: 503 }) : OFF() };
  }
  if (fr?.state === 'starting') return { response: SETUP('<h1>Starting up</h1><p>The first check has not run yet. Reload in a minute.</p>', 503) };
  return { response: api ? Response.json({ error: 'console off' }, { status: 503 }) : OFF() };
}

/** Which sign-in doors exist right now. Presence and state only, never a key, hash or audience value. */
export async function doorStatus(env, { doors, now = Date.now() } = {}) {
  const fr = doors && env.DB ? await firstRunState(env.DB, { now, minutes: doors.first_run_minutes ?? 60 }).catch(() => null) : null;
  return {
    token: Boolean(env.CONSOLE_TOKEN),
    access: accessConfigured(doors),
    first_run: fr ? fr.state : (doors ? 'unknown' : 'disabled'),
  };
}
