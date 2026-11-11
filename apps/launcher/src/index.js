// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Door A launcher Worker (US-SPEC-19). Serves the page and two small endpoints. Stores nothing about the visitor.
// Abuse controls are layered and optional by binding: a rate limiter (RATE_LIMITER) and a Turnstile check (TURNSTILE_SECRET).
import { launcherPage } from './page.js';
import { fetchChallenge, provision, ProvisionError } from './provision.js';
import { BUNDLE, BUNDLE_SHA256, MIGRATIONS_SQL, COMPATIBILITY_DATE } from './bundle.generated.js';

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; worker-src blob:; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const baseHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...baseHeaders, 'content-type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(launcherPage({ bundleSha256: BUNDLE_SHA256 }), { headers: { ...baseHeaders, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP } });
    }
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, launcher: true, release: BUNDLE_SHA256 });
    if (request.method === 'GET' && url.pathname === '/api/challenge') {
      const limited = await limit(env, request); if (limited) return limited;
      try { return json(await fetchChallenge()); } catch (e) { return json({ error: plain(e) }, 502); }
    }
    if (request.method === 'POST' && url.pathname === '/api/provision') {
      if (request.headers.get('origin') !== url.origin) return json({ error: 'This request did not come from the launcher page.' }, 403);
      const limited = await limit(env, request); if (limited) return limited;
      let b; try { b = await request.json(); } catch { return json({ error: 'That request could not be read.' }, 400); }
      if (env.TURNSTILE_SECRET && !(await turnstileOk(env, b.turnstile, request))) return json({ error: 'The robot check failed. Please try again.' }, 403);
      if (b.acceptedLicense !== true) return json({ error: 'Please confirm you have read the license summary.' }, 400);
      try {
        const r = await provision({
          proof: b.proof, acceptedCloudflareTerms: b.acceptedCloudflareTerms === true,
          answers: { idea: b.idea, outcomes: b.outcomes, limit: b.limit, orgName: b.orgName },
          release: { bundle: BUNDLE, bundleSha256: BUNDLE_SHA256, migrationsSql: MIGRATIONS_SQL, compatibilityDate: COMPATIBILITY_DATE },
        });
        return json(r);
      } catch (e) { return json({ error: plain(e) }, e instanceof ProvisionError && e.status >= 400 && e.status < 500 ? e.status : 502); }
    }
    return json({ error: 'Not found.' }, 404);
  },
};

const plain = (e) => (e instanceof ProvisionError || e instanceof Error ? e.message : 'Something went wrong.');

async function limit(env, request) {
  if (!env.RATE_LIMITER) return null;
  const key = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await env.RATE_LIMITER.limit({ key });
  return success ? null : json({ error: 'Too many tries from here. Please wait a minute and try again.' }, 429);
}

async function turnstileOk(env, token, request) {
  if (!token) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: request.headers.get('cf-connecting-ip') || '' });
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  return Boolean((await r.json()).success);
}
