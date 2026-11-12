// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createVault } from '../vault/index.js';
import { readSession, canWrite } from '../auth/index.js';
import { createSignin, SESSION_COOKIE } from './signin.js';

const MIG = fileURLToPath(new URL('../vault/migrations/', import.meta.url));
const BASE = 'https://work.example.test';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
async function setup(admin) {
  const vault = createVault({ db: makeDb([MIG]) });
  await vault.put('GITHUB_APP_CLIENT_ID', 'Iv1.client-id', {}); await vault.put('GITHUB_APP_CLIENT_SECRET', 'client-secret-value', {});
  const calls = [];
  const fetch = async (u, o = {}) => {
    calls.push(String(u));
    if (String(u).endsWith('/login/oauth/access_token')) return json({ access_token: 'user-token-123' });
    if (String(u).endsWith('/user')) return json({ login: 'octocat' });
    if (String(u).endsWith('/repos/ultrastable/workers')) return json(admin === null ? { message: 'Not Found' } : { permissions: { admin } }, admin === null ? 404 : 200);
    return json({}, 404);
  };
  return { vault, calls, handle: createSignin({ vault, fetch, repo: 'ultrastable/workers', now: 1000 }) };
}
const get = (path, cookie = '') => new Request(BASE + path, { headers: cookie ? { cookie } : {} });

test('sign-in sends the user to GitHub with a state bound to the browser', async () => {
  const { handle } = await setup(true);
  const r = await handle(get('/console/github/signin'));
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(loc.searchParams.get('client_id'), 'Iv1.client-id');
  assert.equal(loc.searchParams.get('redirect_uri'), BASE + '/console/github/signin/callback');
  assert.match(r.headers.get('set-cookie'), new RegExp('us_signin_state=' + loc.searchParams.get('state')));
});

test('a repository admin gets an owner session read from the repository, with no typed value', async () => {
  const { handle, vault } = await setup(true);
  const r = await handle(get('/console/github/signin/callback?code=abcdef12&state=st1', 'us_signin_state=st1'));
  assert.equal(r.status, 303);
  const token = r.headers.get('set-cookie').match(new RegExp(SESSION_COOKIE + '=([^;]+)'))[1];
  const s = await readSession(token, { key: await vault.read('SESSION_KEY'), now: 2000 });
  assert.deepEqual([s.login, s.role, canWrite(s)], ['octocat', 'owner', true]);
});

test('a non-admin or a user with no access to the repository is only a viewer', async () => {
  for (const admin of [false, null]) {
    const { handle, vault } = await setup(admin);
    const r = await handle(get('/console/github/signin/callback?code=abcdef12&state=st1', 'us_signin_state=st1'));
    const token = r.headers.get('set-cookie').match(new RegExp(SESSION_COOKIE + '=([^;]+)'))[1];
    assert.equal(canWrite(await readSession(token, { key: await vault.read('SESSION_KEY'), now: 2000 })), false);
  }
});

test('a callback whose state does not match the browser, or before GitHub is connected, is refused', async () => {
  const { handle } = await setup(true);
  assert.equal((await handle(get('/console/github/signin/callback?code=abcdef12&state=evil', 'us_signin_state=st1'))).status, 400);
  assert.equal((await handle(get('/console/github/signin/callback?code=abcdef12&state=st1'))).status, 400);
  const bare = createSignin({ vault: createVault({ db: makeDb([MIG]) }), fetch: async () => json({}), repo: 'a/b' });
  assert.equal((await bare(get('/console/github/signin'))).status, 409);
});
