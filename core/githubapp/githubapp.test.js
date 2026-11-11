// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createVault } from '../vault/index.js';
import { createGithubApp, createInstallationTokenProvider, manifest, signJwt, githubConnection } from './index.js';
import { createGithubVcs } from '../runner/vcs-github.js';
import { createOrg, runnerNeeds } from '../org/index.js';

const VAULT_MIG = fileURLToPath(new URL('../vault/migrations/', import.meta.url));
const KEY = 'console-access-key-123';
const BASE = 'https://work.example.test';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PKCS8 = privateKey.export({ type: 'pkcs8', format: 'pem' });
const PKCS1 = privateKey.export({ type: 'pkcs1', format: 'pem' });
const newVault = () => { const db = makeDb([VAULT_MIG]); return { db, vault: createVault({ db }) }; };
const req = (path, { authed = true, cookies = '' } = {}) => new Request(BASE + path, { headers: { cookie: [authed ? `us_console=${KEY}` : '', cookies].filter(Boolean).join('; ') } });
const b64u = s => Buffer.from(s, 'base64url');

test('manifest asks for the minimum permissions and no admin, webhook, or workflows', () => {
  const m = manifest({ baseUrl: BASE + '/' });
  assert.deepEqual(m.default_permissions, { contents: 'write', pull_requests: 'write', issues: 'write', checks: 'read', metadata: 'read' });
  assert.equal(m.hook_attributes.active, false);
  assert.equal(m.redirect_url, BASE + '/console/github/callback');
  assert.equal(m.setup_url, BASE + '/console/github/installed');
  assert.ok(!JSON.stringify(m).includes('admin'));
  assert.equal(manifest({ baseUrl: BASE, workflows: true }).default_permissions.workflows, 'write');
  assert.throws(() => manifest({}), /baseUrl/);
});

test('JWT verifies with the public key and has the right iss, iat, exp (PKCS8 and PKCS1 keys)', async () => {
  for (const pem of [PKCS8, PKCS1]) {
    const now = 1_800_000_000_000;
    const jwt = await signJwt({ appId: 4242, pem, now });
    const [h, p, s] = jwt.split('.');
    assert.deepEqual(JSON.parse(b64u(h)), { alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(b64u(p));
    assert.deepEqual(claims, { iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 540, iss: '4242' });
    assert.ok(claims.exp - claims.iat <= 600);
    const v = createVerify('RSA-SHA256').update(h + '.' + p);
    assert.equal(v.verify(publicKey, b64u(s)), true);
  }
});

function setup({ fetch, now = () => 1_800_000_000_000 } = {}) {
  const { db, vault } = newVault();
  const app = createGithubApp({ vault, fetch, now, consoleToken: KEY, config: { org: 'acme' } });
  return { db, vault, app };
}
async function connectState(app) {
  const res = await app(req('/console/github/connect'));
  const html = await res.text();
  const state = decodeURIComponent(html.match(/apps\/new\?state=([^"]+)"/)[1]);
  const nonce = res.headers.get('set-cookie').match(/us_gh_state=([a-f0-9]+)/)[1];
  return { res, html, state, nonce };
}

test('connect page posts the manifest to the organization on GitHub with one button', async () => {
  const { app } = setup();
  const { res, html } = await connectState(app);
  assert.equal(res.status, 200);
  assert.match(html, /action="https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=/);
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.match(html, /name=manifest/);
  assert.match(html, /pull_requests/);
});

test('a state mismatch, a missing cookie, an expired or reused state is refused and nothing is stored', async () => {
  let calls = 0;
  const { app, vault } = setup({ fetch: async () => { calls++; return json({}); } });
  const { state, nonce } = await connectState(app);
  const cb = (s, c) => app(req(`/console/github/callback?code=abcdef123456&state=${encodeURIComponent(s)}`, { cookies: c ? `us_gh_state=${c}` : '' }));
  assert.equal((await cb('x.y.z', nonce)).status, 400);
  assert.equal((await cb(state, 'deadbeef')).status, 400);
  assert.equal((await cb(state, '')).status, 400);
  assert.equal(calls, 0);
  assert.equal(await vault.has('GITHUB_APP_ID'), false);
  // expired
  let t = 1_800_000_000_000;
  const e = setup({ fetch: async () => json({}), now: () => t });
  const s2 = await connectState(e.app);
  t += 16 * 60e3;
  const r = await e.app(req(`/console/github/callback?code=abcdef123456&state=${encodeURIComponent(s2.state)}`, { cookies: `us_gh_state=${s2.nonce}` }));
  assert.equal(r.status, 400);
});

test('the code exchange stores id, key and webhook secret in the vault and nothing secret is echoed; state is single use', async () => {
  const WH = 'webhook-secret-value-xyz';
  const seen = [];
  const { app, vault } = setup({ fetch: async (url, init) => { seen.push([url, init.method]); return json({ id: 99, slug: 'my-app', pem: PKCS1, webhook_secret: WH, client_secret: 'cs-should-not-be-kept-1' }); } });
  const { state, nonce } = await connectState(app);
  const path = `/console/github/callback?code=abcdef123456&state=${encodeURIComponent(state)}`;
  const res = await app(req(path, { cookies: `us_gh_state=${nonce}` }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://github.com/apps/my-app/installations/new');
  assert.deepEqual(seen, [['https://api.github.com/app-manifests/abcdef123456/conversions', 'POST']]);
  const body = await res.text();
  const all = body + JSON.stringify([...res.headers]);
  for (const secret of [PKCS1, WH, 'cs-should-not-be-kept-1', 'BEGIN']) assert.ok(!all.includes(secret));
  assert.equal(await vault.read('GITHUB_APP_PRIVATE_KEY'), PKCS1.trim());
  assert.equal(await vault.read('GITHUB_APP_WEBHOOK_SECRET'), WH);
  assert.ok((await vault.read('GITHUB_APP_ID')).endsWith('99'));
  assert.ok(!(await vault.names()).some(n => n.name === 'GITHUB_APP_CLIENT_SECRET'));
  assert.equal((await app(req(path, { cookies: `us_gh_state=${nonce}` }))).status, 400); // replay
});

test('installed stores the installation id and says Connected; bad ids are refused', async () => {
  const { app, vault } = setup();
  assert.equal((await app(req('/console/github/installed?installation_id=abc'))).status, 400);
  const res = await app(req('/console/github/installed?installation_id=1234567'));
  assert.match(await res.text(), /Connected/);
  assert.equal(await vault.has('GITHUB_APP_INSTALLATION_ID'), true);
  assert.equal((await githubConnection(vault)).present, false); // id and key still missing
});

test('connect, callback and installed refuse unauthenticated requests; other paths return null', async () => {
  const { app, vault } = setup({ fetch: async () => { throw new Error('must not be called'); } });
  for (const p of ['/console/github/connect', '/console/github/callback?code=abcdef123456&state=a.b.c', '/console/github/installed?installation_id=5']) {
    assert.equal((await app(req(p, { authed: false }))).status, 401);
  }
  assert.equal((await app(new Request(BASE + '/console/github/connect', { headers: { cookie: 'us_console=wrong' } }))).status, 401);
  const off = createGithubApp({ vault, fetch: async () => json({}), consoleToken: undefined });
  assert.equal((await off(req('/console/github/connect'))).status, 401);
  assert.equal(await vault.has('GITHUB_APP_INSTALLATION_ID'), false);
  assert.equal(await app(req('/elsewhere')), null);
});

async function readyVault() {
  const { db, vault } = newVault();
  await vault.put('GITHUB_APP_ID', 'app-id:77');
  await vault.put('GITHUB_APP_PRIVATE_KEY', PKCS8);
  await vault.put('GITHUB_APP_INSTALLATION_ID', 'installation-id:555');
  return { db, vault };
}

test('installation token is cached, then refreshed within 5 minutes of expiry; the token is in no table', async () => {
  const { db, vault } = await readyVault();
  let t = 1_800_000_000_000, n = 0; const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    n++;
    return json({ token: `ghs_TOKEN_${n}_secretvalue`, expires_at: new Date(t + 60 * 60e3).toISOString() }, 201);
  };
  const get = createInstallationTokenProvider({ vault, fetch, now: () => t });
  assert.equal(await get(), 'ghs_TOKEN_1_secretvalue');
  t += 50 * 60e3; // 10 minutes left: still cached
  assert.equal(await get(), 'ghs_TOKEN_1_secretvalue');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/app/installations/555/access_tokens');
  t += 6 * 60e3; // 4 minutes left: refresh
  assert.equal(await get(), 'ghs_TOKEN_2_secretvalue');
  assert.equal(calls.length, 2);
  // the Bearer value was a valid app JWT for app 77
  const [h, p, s] = calls[0].auth.replace('Bearer ', '').split('.');
  assert.equal(JSON.parse(b64u(p)).iss, '77');
  assert.equal(createVerify('RSA-SHA256').update(h + '.' + p).verify(publicKey, b64u(s)), true);
  for (const name of db.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name)) {
    assert.ok(!JSON.stringify(db.raw.prepare(`SELECT * FROM ${name}`).all()).includes('ghs_TOKEN'), `token leaked into ${name}`);
  }
});

test('a failed token request throws an error that holds neither the JWT nor the key', async () => {
  const { vault } = await readyVault();
  const get = createInstallationTokenProvider({ vault, fetch: async () => json({ message: 'Bad credentials' }, 401) });
  await assert.rejects(get, e => /http 401/.test(e.message) && !e.message.includes('BEGIN') && !e.message.includes('eyJ'));
  const get2 = createInstallationTokenProvider({ vault: newVault().vault, fetch: async () => json({}) });
  await assert.rejects(get2, /not complete/);
});

test('the vcs adapter uses a tokenProvider when given and the env variable otherwise', async () => {
  const seen = [];
  const fetch = async (url, init) => { seen.push(init.headers.authorization); return json({ type: 'file', encoding: 'utf-8', content: 'hi' }); };
  const a = createGithubVcs({ fetch, repo: 'o/r', env: {}, tokenProvider: async () => 'ghs_from_provider' });
  assert.equal(await a.getFile('x.txt'), 'hi');
  const b = createGithubVcs({ fetch, repo: 'o/r', env: { VCS_TOKEN: 'ghp_from_env_value' } });
  await b.getFile('x.txt');
  assert.deepEqual(seen, ['Bearer ghs_from_provider', 'Bearer ghp_from_env_value']);
  const c = createGithubVcs({ fetch: async () => { throw new Error('boom ghs_from_provider'); }, repo: 'o/r', tokenProvider: async () => 'ghs_from_provider' });
  await assert.rejects(c.getFile('x'), e => !e.message.includes('ghs_from_provider'));
  const d = createGithubVcs({ fetch, repo: 'o/r', tokenProvider: async () => { throw new Error('nope'); } });
  await assert.rejects(d.getFile('x'), /token provider failed/);
});

test('runnerNeeds is satisfied by vault app credentials; org reads them at tick time and serves the routes', async () => {
  const cfg = { runner: { enabled: true }, vcs: { repo: 'o/r' }, router: { providers: { a: { key_env: 'KEY_A' } } } };
  assert.deepEqual(runnerNeeds(cfg, { KEY_A: 'x' }), ['VCS_TOKEN']);
  assert.deepEqual(runnerNeeds(cfg, { KEY_A: 'x' }, { appCredentials: true }), []);

  const { db, vault } = await readyVault();
  const fetch = async () => json({ token: 'ghs_org_token_value', expires_at: new Date(Date.now() + 3600e3).toISOString() }, 201);
  const org = createOrg({ db, vault, fetch, env: { KEY_A: 'x', CONSOLE_TOKEN: KEY }, config: cfg });
  assert.ok(!org.extraSteps().some(s => s.name === 'runner')); // before the first tick the credentials are not yet known
  try { await org.tick(); } catch { /* the tick's own outcome is not under test */ }
  assert.ok(!org.extraSteps().some(s => s.name === 'runner_needs'), 'runner no longer asks for VCS_TOKEN');
  assert.ok(org.extraSteps().some(s => s.name === 'runner'));
  assert.equal((await org.handle(req('/console/github/connect', { authed: false }))).status, 401);
  assert.equal((await org.handle(req('/console/github/connect'))).status, 200);
});
