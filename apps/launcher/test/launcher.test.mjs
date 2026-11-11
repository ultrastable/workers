// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import launcher from '../src/index.js';
import { launcherPage } from '../src/page.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const U = 'https://launch.example';

test('the page is plain words: no terminal, both agreements unticked, no innerHTML, no third-party scripts', () => {
  const html = launcherPage({ bundleSha256: 'a'.repeat(64) });
  assert.match(html, /Say what you want/);
  assert.match(html, /free for non-commercial use/i);
  assert.match(html, /Cloudflare's terms/);
  const stripped = html.replace('No code, no terminal.', '').replace('or a terminal?', '').replace(/var POW_SRC=.*?;document/s, 'document');
  assert.doesNotMatch(stripped, /terminal|command line|npm install|npx |wrangler/i, 'no instruction that needs a terminal');
  assert.doesNotMatch(html, /innerHTML|document\.write|eval\(/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /\schecked[\s>=]/);
  assert.match(html, /id="go" disabled/);
});

test('page headers: CSP locks it down, nothing is cached', async () => {
  const r = await launcher.fetch(new Request(U + '/'), {});
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/); assert.match(csp, /worker-src blob:/); assert.match(csp, /connect-src 'self'/); assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

function withFakeCloudflare(fn) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); calls.push(u);
    const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
    if (u.includes('/challenge')) return ok({ challengeToken: 'ct', seed: 'AAAA', k: 2, g: 2 });
    if (u.endsWith('/provisioning/previews')) return ok({ account: { id: 'a1', apiToken: 'T', expiresAt: 'x' }, claim: { token: 'C', url: 'https://dash.example/claim?claimToken=C', expiresAt: 'x' } });
    if (u.endsWith('/d1/database')) return ok({ uuid: 'd1' });
    if (u.endsWith('/workers/subdomain')) return ok({ subdomain: 'sub' });
    return ok({});
  };
  return fn(calls).finally(() => { globalThis.fetch = orig; });
}

const body = (extra = {}) => ({ proof: { challengeToken: 'ct', solution: { checkpoints: 'AAAA' } }, idea: 'A neighbourhood tool library for borrowing tools', outcomes: ['Book a drill'], limit: 0, acceptedCloudflareTerms: true, acceptedLicense: true, ...extra });
const post = (b, origin = U) => new Request(U + '/api/provision', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(b) });

test('provisioning endpoint: same-origin only, both agreements required, then it works', async () => {
  await withFakeCloudflare(async (calls) => {
    assert.equal((await launcher.fetch(post(body(), null), {})).status, 403);
    assert.equal((await launcher.fetch(post(body(), 'https://evil.example'), {})).status, 403);
    assert.equal((await launcher.fetch(post(body({ acceptedLicense: false })), {})).status, 400);
    const noTos = await launcher.fetch(post(body({ acceptedCloudflareTerms: false })), {});
    assert.equal(noTos.status, 400); assert.match((await noTos.json()).error, /terms/i);
    assert.equal(calls.length, 0, 'nothing was created without both agreements');
    const ok = await launcher.fetch(post(body()), {});
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.match(j.url, /^https:\/\/.+\.sub\.workers\.dev$/); assert.match(j.claimUrl, /claimToken=C/); assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.ok(!JSON.stringify(j).includes('"T"'));
  });
});

test('abuse hooks: a rate limiter that says no stops the request before any outside call; a failed robot check too', async () => {
  await withFakeCloudflare(async (calls) => {
    const env = { RATE_LIMITER: { limit: async () => ({ success: false }) } };
    assert.equal((await launcher.fetch(post(body()), env)).status, 429);
    assert.equal((await launcher.fetch(new Request(U + '/api/challenge'), env)).status, 429);
    const env2 = { TURNSTILE_SECRET: 's' };
    assert.equal((await launcher.fetch(post(body()), env2)).status, 403);
    assert.equal(calls.length, 0);
  });
});

test('no personal data is stored: the launcher has no bindings to write to and logs nothing', async () => {
  const src = ['index.js', 'provision.js'].map(f => readFileSync(path.join(HERE, '..', 'src', f), 'utf8')).join('\n');
  assert.doesNotMatch(src, /console\.(log|info|warn|error)/);
  assert.doesNotMatch(src, /env\.(DB|KV|BUCKET|STORE)\b|\.put\(|localStorage|document\.cookie/);
});

// Slow (downloads wrangler on first use): run with ULTRASTABLE_BUILD_TEST=1. CI runs it on release builds.
test('the built preview bundle is a working Worker with the published hash', { skip: process.env.ULTRASTABLE_BUILD_TEST !== '1' }, async () => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'us-bundle-')), 'bundle.generated.mjs');
  const r = spawnSync(process.execPath, [path.join(HERE, '..', 'build.mjs'), '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const mod = await import(pathToFileURL(out).href);
  assert.match(mod.BUNDLE_SHA256, /^[0-9a-f]{64}$/);
  assert.match(mod.MIGRATIONS_SQL, /CREATE TABLE IF NOT EXISTS items/);
  assert.match(mod.MIGRATIONS_SQL, /console_actions/);
  const worker = (await import('data:text/javascript;base64,' + Buffer.from(mod.BUNDLE).toString('base64'))).default;
  const health = await worker.fetch(new Request(U + '/health'), { ORG_SLUG: 'x' });
  assert.deepEqual(await health.json(), { ok: true, preview: true, org: 'x', last_tick: null, note: 'Preview: scheduled work starts after the account is claimed and the heartbeat is set up.' });
  assert.equal((await worker.fetch(new Request(U + '/console'), {})).status, 503, 'console is off without a key');
});
