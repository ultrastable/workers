// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// OWNER-AUTH-1 (c): the console signs in with the us_session cookie; viewers see the read-only dashboard; owners confirm every write.
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeDb } from './d1shim.js';
import { createVault } from '../vault/index.js';
import { issueSession } from '../auth/index.js';
import { handleConsole, githubSigninActive } from '../src/console.js';
import { renderPublicView, measureRows, publicViewEnabled } from '../org/public-view.js';

const U = 'https://x.example', KEY = 'k'.repeat(32), NOW = Date.UTC(2026, 10, 12);
async function setup({ connected = true, pub = false } = {}) {
  const db = makeDb();
  for (const m of ['vault/migrations/0001_vault.sql', 'runner/migrations/0001_runner.sql', 'router/migrations/0001_router.sql']) db.raw.exec(readFileSync(new URL('../' + m, import.meta.url), 'utf8'));
  const vault = createVault({ db });
  if (connected) { await vault.put('GITHUB_APP_CLIENT_ID', 'cid-12345678'); await vault.put('GITHUB_APP_CLIENT_SECRET', 'csecret-12345678'); await vault.put('SESSION_KEY', KEY); }
  const config = { vcs: { repo: 'o/r' }, ...(pub ? { public_metrics: { enabled: true } } : {}) };
  const env = { DB: db, CONSOLE_TOKEN: 'correct-horse' };
  const as = async role => ({ cookie: 'us_session=' + await issueSession({ login: 'ann', role, key: KEY, now: NOW }) });
  const call = (path, headers = {}, init = {}) => handleConsole(new Request(U + path, { headers, ...init }), env, { vault, config, now: () => NOW });
  return { db, vault, call, as };
}

test('sign-in is off until GitHub is connected: the older doors still work', async () => {
  const { call, vault } = await setup({ connected: false });
  assert.equal(await githubSigninActive(vault, { vcs: { repo: 'o/r' } }), false);
  assert.equal((await call('/api/console')).status, 401);
  const ok = await call('/console/login', {}, { method: 'POST', body: new URLSearchParams({ key: 'correct-horse' }) });
  assert.equal(ok.status, 303);
});

test('once connected, CONSOLE_TOKEN no longer signs anyone in', async () => {
  const { call } = await setup();
  const r = await call('/console/login', {}, { method: 'POST', body: new URLSearchParams({ key: 'correct-horse' }) });
  assert.equal(r.status, 410);
  const withKeyCookie = await call('/api/console', { cookie: 'us_console=correct-horse' });
  assert.equal(withKeyCookie.status, 401);
});

test('no session and not public: a sign-in page; nothing leaks', async () => {
  const { call } = await setup();
  const r = await call('/console'); assert.equal(r.status, 401); assert.match(await r.text(), /github\/signin/);
  assert.equal((await call('/api/console/public')).status, 401);
});

test('public view is opt-in: anonymous and viewers see only the five measures', async () => {
  const { call, as } = await setup({ pub: true });
  const page = await call('/console'); assert.equal(page.status, 200);
  const html = await page.text();
  for (const n of ['Remaining capabilities', 'Agent pull requests', 'Predictions right', 'Money', 'Autonomy']) assert.match(html, new RegExp(n));
  assert.doesNotMatch(html, /<script/i);
  const v = await call('/console', await as('viewer')); assert.match(await v.text(), /Signed in as ann \(read-only\)/);
  assert.equal((await call('/api/console', await as('viewer'))).status, 403);
  assert.equal((await call('/api/console/card', await as('viewer'), { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await call('/api/console/public')).status, 200);
});

test('a signed-in viewer is refused when the public view is off', async () => {
  const { call, as } = await setup();
  assert.equal((await call('/console', await as('viewer'))).status, 403);
});

test('an owner session gets the console; every write needs a confirm and is recorded with who did it', async () => {
  const { call, as, db } = await setup();
  const h = { ...(await as('owner')), 'content-type': 'application/json', origin: U };
  assert.equal((await call('/api/console', h)).status, 200);
  assert.match(await (await call('/console', h)).text(), /Say what you want/);
  const ask = body => call('/api/console/ask', h, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await ask({ text: 'hello' })).status, 428);
  assert.equal((await ask({ text: 'hello', confirm: true })).status, 200);
  const row = db.raw.prepare("SELECT ref, text FROM console_actions WHERE kind='signed_action'").get();
  assert.deepEqual({ ...row }, { ref: 'ask', text: 'ann' });
});

test('a forged or expired session is nobody', async () => {
  const { call } = await setup();
  const forged = 'us_session=' + await issueSession({ login: 'eve', role: 'owner', key: 'z'.repeat(32), now: NOW });
  assert.equal((await call('/api/console', { cookie: forged })).status, 401);
  const old = 'us_session=' + await issueSession({ login: 'ann', role: 'owner', key: KEY, now: NOW - 9 * 3600e3 });
  assert.equal((await call('/api/console', { cookie: old })).status, 401);
});

test('renderPublicView escapes and says why a measure is missing', () => {
  const m = { generated_at: '<x>', remaining_capabilities: null, agent_prs: { opened: 1, merged: null, rejected: 0, open: 1 }, predictions: null, money: { spend_usd: 0, cap_usd: null, cost_per_merged_pr_usd: null }, autonomy: null, not_measured: { predictions: 'none scored' } };
  assert.equal(measureRows(m).length, 5);
  const h = renderPublicView(m); assert.match(h, /&lt;x&gt;/); assert.match(h, /none scored/);
  assert.equal(publicViewEnabled({}), false);
});
