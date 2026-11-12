// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// US-SPEC-19-R09: Turnstile verification, own spend cap, no personal data retained, claim link never logged.
// Everything runs against a fake siteverify and a fake Cloudflare; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import launcher, { ProvisionCap } from '../src/index.js';
import { verifyTurnstile, SITEVERIFY_URL } from '../src/turnstile.js';
import { takeCap } from '../src/cap.js';
import { launcherPage } from '../src/page.js';

const U = 'https://launch.example';
const SECRET = 'ts-secret-ZZZ999';
const siteverify = (answer, seen = []) => async (url, init) => {
  seen.push({ url: String(url), body: String(init.body) });
  if (answer instanceof Error) throw answer;
  return new Response(JSON.stringify(answer), { status: 200 });
};

test('verifyTurnstile: only a clean success passes; every other shape fails closed', async () => {
  const seen = [];
  const ok = await verifyTurnstile({ secret: SECRET, token: 'tok', ip: '1.2.3.4', fetchImpl: siteverify({ success: true, action: 'provision', hostname: 'launch.example' }, seen) });
  assert.deepEqual(ok, { ok: true, reason: 'verified' });
  assert.equal(seen[0].url, SITEVERIFY_URL);
  assert.equal(new URLSearchParams(seen[0].body).get('response'), 'tok');
  assert.equal(new URLSearchParams(seen[0].body).get('remoteip'), '1.2.3.4');
  const f = async (args, answer) => (await verifyTurnstile({ secret: SECRET, token: 'tok', fetchImpl: siteverify(answer), ...args })).reason;
  assert.equal(await f({}, { success: false, 'error-codes': ['invalid-input-response'] }), 'rejected');
  assert.equal(await f({ hostname: 'launch.example' }, { success: true, hostname: 'evil.example' }), 'wrong_hostname');
  assert.equal(await f({}, { success: true, action: 'login' }), 'wrong_action');
  assert.equal(await f({}, new Error('offline')), 'siteverify_unreachable');
  assert.equal(await f({ token: '' }, { success: true }), 'no_token');
  assert.equal(await f({ token: 'x'.repeat(2049) }, { success: true }), 'token_too_long');
  assert.equal(await f({ secret: '' }, { success: true }), 'no_secret');
  assert.equal((await verifyTurnstile({ secret: SECRET, token: 't', fetchImpl: async () => new Response('<html>', { status: 200 }) })).reason, 'siteverify_unreadable');
  assert.equal((await verifyTurnstile({ secret: SECRET, token: 't', fetchImpl: async () => new Response('', { status: 500 }) })).reason, 'siteverify_status');
  const slow = (await verifyTurnstile({ secret: SECRET, token: 't', timeoutMs: 10, fetchImpl: (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))) })).reason;
  assert.equal(slow, 'siteverify_unreachable');
});

// A fake Durable Object namespace backed by the real ProvisionCap class and an in-memory storage.
function fakeCapNamespace() {
  const mem = new Map();
  const storage = { get: async k => mem.get(k), put: async (k, v) => { mem.set(k, v); }, delete: async k => { mem.delete(k); }, list: async () => new Map(mem) };
  const obj = new ProvisionCap({ storage });
  return { mem, idFromName: n => n, get: () => ({ fetch: (u, init) => obj.fetch(new Request(u, init)) }) };
}

test('spend cap: N attempts per UTC day, then refused; a new day resets; only integers are stored', async () => {
  const ns = fakeCapNamespace();
  const env = { PROVISION_CAP: ns, DAILY_PROVISION_CAP: '2' };
  const day1 = Date.parse('2026-11-12T10:00:00Z'), day2 = Date.parse('2026-11-13T00:00:01Z');
  assert.equal((await takeCap(env, { now: day1 })).used, 1);
  assert.equal((await takeCap(env, { now: day1 + 1000 })).ok, true);
  const over = await takeCap(env, { now: day1 + 2000 });
  assert.deepEqual([over.ok, over.reason, over.used, over.max], [false, 'over_cap', 2, 2]);
  assert.equal((await takeCap(env, { now: day2 })).ok, true);
  assert.deepEqual([...ns.mem.keys()], ['2026-11-13'], 'yesterday deleted, no history kept');
  assert.ok([...ns.mem.values()].every(Number.isInteger));
  assert.equal((await takeCap({}, {})).reason, 'no_cap_binding');
  assert.equal((await takeCap({ PROVISION_CAP: ns, DAILY_PROVISION_CAP: 'abc' }, {})).reason, 'bad_cap_setting');
  assert.equal((await takeCap({ PROVISION_CAP: { idFromName: () => 1, get: () => { throw new Error('x'); } } }, {})).reason, 'cap_unreachable');
});

function fakeWorld(verifyAnswer, seen) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === SITEVERIFY_URL) return siteverify(verifyAnswer, seen)(url, init);
    const ok = result => new Response(JSON.stringify({ success: true, result }), { status: 200 });
    if (u.includes('/challenge')) return ok({ challengeToken: 'ct', seed: 'AAAA', k: 2, g: 2 });
    if (u.endsWith('/provisioning/previews')) return ok({ account: { id: 'a1', apiToken: 'TOKEN-SECRET-1', expiresAt: 'x' }, claim: { token: 'CLAIM-TOKEN-777', url: 'https://dash.example/claim?claimToken=CLAIM-TOKEN-777', expiresAt: 'x' } });
    if (u.endsWith('/d1/database')) return ok({ uuid: 'd1' });
    if (u.endsWith('/workers/subdomain')) return ok({ subdomain: 'sub' });
    return ok({});
  };
  return () => { globalThis.fetch = orig; };
}
const body = (extra = {}) => ({ proof: { challengeToken: 'ct', solution: { checkpoints: 'AAAA' } }, idea: 'A neighbourhood tool library for borrowing tools', outcomes: ['Book a drill'], limit: 0, acceptedCloudflareTerms: true, acceptedLicense: true, turnstile: 'good-token', ...extra });
const post = (b, headers = {}) => new Request(U + '/api/provision', { method: 'POST', headers: { 'content-type': 'application/json', origin: U, 'cf-connecting-ip': '203.0.113.9', ...headers }, body: JSON.stringify(b) });

test('worker: robot check gates provisioning; a good token plus cap room provisions; no personal data or claim link leaks', async () => {
  const seen = [];
  const restore = fakeWorld({ success: true, action: 'provision', hostname: 'launch.example' }, seen);
  const logged = [];
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map(m => { const o = console[m]; console[m] = (...a) => logged.push(a.join(' ')); return [m, o]; });
  try {
    const ns = fakeCapNamespace();
    const env = { TURNSTILE_SECRET: SECRET, TURNSTILE_HOSTNAME: 'launch.example', PROVISION_CAP: ns, DAILY_PROVISION_CAP: '1' };
    assert.equal((await launcher.fetch(post(body({ turnstile: '' })), env)).status, 403);
    assert.equal(seen.length, 0, 'no token, no siteverify call');
    const ok = await launcher.fetch(post(body()), env);
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.match(j.claimUrl, /CLAIM-TOKEN-777/);
    assert.equal(seen.length, 1);
    assert.equal(new URLSearchParams(seen[0].body).get('remoteip'), '203.0.113.9', 'address used only for the check');
    const second = await launcher.fetch(post(body()), env);
    assert.equal(second.status, 503, 'over the daily cap');
    assert.doesNotMatch((await second.json()).error, /CLAIM|TOKEN/);
    assert.deepEqual([...ns.mem.values()], [1]);
    assert.equal(logged.filter(l => /CLAIM-TOKEN-777|claimToken|TOKEN-SECRET-1|203\.0\.113\.9|good-token/.test(l)).length, 0, 'nothing sensitive logged');
  } finally { for (const [m, o] of spies) console[m] = o; restore(); }
});

test('a rejected token and an unreachable siteverify both stop the request before anything is created', async () => {
  for (const answer of [{ success: false }, new Error('down')]) {
    const seen = [];
    const restore = fakeWorld(answer, seen);
    try {
      const r = await launcher.fetch(post(body()), { TURNSTILE_SECRET: SECRET });
      assert.equal(r.status, 403);
      assert.equal(seen.length, 1);
    } finally { restore(); }
  }
});

test('LAUNCHER_MODE=public refuses to serve until robot check, rate limit and cap are all configured', async () => {
  const full = { LAUNCHER_MODE: 'public', TURNSTILE_SECRET: SECRET, TURNSTILE_SITE_KEY: '0x4AAAA-key', RATE_LIMITER: { limit: async () => ({ success: true }) }, PROVISION_CAP: fakeCapNamespace() };
  for (const missing of ['TURNSTILE_SECRET', 'TURNSTILE_SITE_KEY', 'RATE_LIMITER', 'PROVISION_CAP']) {
    const env = { ...full }; delete env[missing];
    assert.equal((await launcher.fetch(new Request(U + '/'), env)).status, 503, missing);
    assert.equal((await launcher.fetch(post(body()), env)).status, 503, missing);
    assert.equal((await launcher.fetch(new Request(U + '/health'), env)).status, 200, 'health stays up');
  }
  assert.equal((await launcher.fetch(new Request(U + '/'), full)).status, 200);
  assert.equal((await launcher.fetch(new Request(U + '/'), {})).status, 200, 'dev and demo mode unchanged');
});

test('page: the widget and its CSP exist only when a valid site key is set', async () => {
  const plain = launcherPage({ bundleSha256: 'a'.repeat(64) });
  assert.doesNotMatch(plain, /challenges\.cloudflare\.com|id="ts"/);
  assert.doesNotMatch(launcherPage({ turnstileSiteKey: '"><script>alert(1)</script>' }), /alert\(1\)/);
  const html = launcherPage({ turnstileSiteKey: '0x4AAAA-key' });
  assert.match(html, /id="ts"/); assert.match(html, /sitekey:TS_KEY/); assert.match(html, /turnstile:TS_TOKEN/);
  const r = await launcher.fetch(new Request(U + '/'), { TURNSTILE_SITE_KEY: '0x4AAAA-key' });
  assert.match(r.headers.get('content-security-policy'), /script-src 'unsafe-inline' https:\/\/challenges\.cloudflare\.com/);
  assert.match(r.headers.get('content-security-policy'), /frame-src https:\/\/challenges\.cloudflare\.com/);
  const off = await launcher.fetch(new Request(U + '/'), {});
  assert.doesNotMatch(off.headers.get('content-security-policy'), /challenges/);
});

test('hosting gate card is machine-readable data with an IDENTITY-BOUND line and a default in effect', () => {
  const card = JSON.parse(readFileSync(new URL('../gate.json', import.meta.url), 'utf8'));
  assert.match(card.line, /^IDENTITY-BOUND:/);
  for (const k of ['id', 'default_in_effect', 'closing_probe']) assert.ok(card[k], k);
  for (const f of card.prepared) assert.ok(readFileSync(new URL('../' + f.replace('apps/launcher/', ''), import.meta.url)).length > 0, f);
});

test('source never logs and never stores a claim link, token or address', () => {
  const src = ['index.js', 'turnstile.js', 'cap.js', 'provision.js'].map(f => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(src, /console\./);
  assert.doesNotMatch(src, /storage\.put\([^)]*(ip|claim|token)/i);
});
