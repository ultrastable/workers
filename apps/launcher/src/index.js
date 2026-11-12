// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Door A launcher Worker (US-SPEC-19). Serves the page and two small endpoints. Stores nothing about the visitor.
// Abuse controls are layered and optional by binding: a rate limiter (RATE_LIMITER) and a Turnstile check (TURNSTILE_SECRET).
import { launcherPage } from './page.js';
import { fetchChallenge, provision, ProvisionError } from './provision.js';
import { verifyTurnstile, validSiteKey } from './turnstile.js';
import { takeCap } from './cap.js';
import { BUNDLE, BUNDLE_SHA256, MIGRATIONS_SQL, COMPATIBILITY_DATE } from './bundle.generated.js';

const CSP_BASE = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; worker-src blob:; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
// With Turnstile on, the page may load the Cloudflare widget script and frame; nothing else changes.
const cspFor = env => (env?.TURNSTILE_SITE_KEY ? CSP_BASE.replace("script-src 'unsafe-inline'", "script-src 'unsafe-inline' https://challenges.cloudflare.com").replace("form-action 'none'", "frame-src https://challenges.cloudflare.com; form-action 'none'") : CSP_BASE);
export { ProvisionCap } from './cap.js';
// LAUNCHER_MODE=public refuses to serve unless the robot check, the rate limit and the daily cap are all configured.
const publicMisconfigured = env => env?.LAUNCHER_MODE === 'public' && (!env.TURNSTILE_SECRET || !validSiteKey(env.TURNSTILE_SITE_KEY) || !env.RATE_LIMITER || !env.PROVISION_CAP);
const baseHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...baseHeaders, 'content-type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/health' && publicMisconfigured(env)) return json({ error: 'The launcher is not ready.' }, 503);
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(launcherPage({ bundleSha256: BUNDLE_SHA256, turnstileSiteKey: validSiteKey(env?.TURNSTILE_SITE_KEY) ? env.TURNSTILE_SITE_KEY : null }), { headers: { ...baseHeaders, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': cspFor(env) } });
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
      if (b.acceptedCloudflareTerms !== true) return json({ error: "Please agree to Cloudflare's terms to continue." }, 400);
      // The launcher's own daily cap: counted only once the request is otherwise valid, before anything is created.
      if (env.PROVISION_CAP || env.LAUNCHER_MODE === 'public') { const cap = await takeCap(env); if (!cap.ok) return json({ error: 'The launcher has reached its limit for today. Please try again tomorrow.' }, 503); }
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
  const v = await verifyTurnstile({ secret: env.TURNSTILE_SECRET, token, ip: request.headers.get('cf-connecting-ip') || '', hostname: env.TURNSTILE_HOSTNAME || null });
  return v.ok;
}
