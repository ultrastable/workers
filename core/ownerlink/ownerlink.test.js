// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createVault } from '../vault/index.js';
import { issueSession } from '../auth/index.js';
import { askOwner } from '../access/index.js';
import { createOwnerlink, createBlueskyClient } from './index.js';

const dirs = ['../vault/migrations/', '../access/migrations/', './migrations/'].map(d => fileURLToPath(new URL(d, import.meta.url)));
const T0 = Date.parse('2026-11-17T12:00:00Z');
const ORIGIN = 'https://org.example';
const resp = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: async () => body });

async function mk(fetchFn, config = {}) {
  const db = makeDb(dirs), vault = createVault({ db });
  await vault.put('SESSION_KEY', 'k'.repeat(32)); await vault.put('GITHUB_APP_CLIENT_ID', 'Iv1.testclient');
  const cookie = 'us_session=' + encodeURIComponent(await issueSession({ login: 'owner', role: 'owner', key: 'k'.repeat(32), now: T0 }));
  const ctx = { db, vault, now: () => T0, fetch: fetchFn || (async () => resp(404, {})), env: { GITHUB_TOKEN: 'x' }, config: { ownerlink: { origin: ORIGIN, mastodon: { instance: 'social.example' }, signup: { mastodon: 'https://social.example/auth/sign_up' }, ...config } } };
  const ol = createOwnerlink(ctx);
  const get = (path, c = cookie, extra = {}) => ol.handle(new Request(ORIGIN + path, { headers: { ...(c ? { cookie: c } : {}), ...extra } }));
  return { ctx, ol, get, cookie, db, vault };
}
const missing = (id = 'x') => ({ 'secret.available': { routes: [{ id: 'env', run: () => ({ outcome: 'absent', detail: 'not set' }) }] }, id });
const ask = (ctx, name, id) => askOwner({ ...ctx, registry: missing() }, { id, what: `connect ${name}`, why_gated: 'needed', default_in_effect: 'skipped', closing_probe: 'manual', capability: 'secret.available', subject: name });

test('the owner page asks an unsigned visitor for one thing: sign in', async () => {
  const { get } = await mk();
  const r = await get('/owner', null);
  assert.equal(r.status, 401); assert.match(await r.text(), /Sign in with GitHub/);
  assert.equal((await get('/api/owner/actions', null)).status, 401);
  assert.equal((await get('/owner/signin', null)).headers.get('location'), '/console/github/signin');
});

test('an owner ask carries one link and appears on the page; a forged session sees nothing', async () => {
  const { ctx, get } = await mk();
  const r = await ask(ctx, 'MASTODON_TOKEN', 'need-masto');
  assert.equal(r.asked, true); assert.equal(r.link, ORIGIN + '/owner/go/need-masto');
  assert.match(ctx.db.raw.prepare('SELECT why_gated FROM gate_cards').get().why_gated, /One click: https:\/\/org\.example\/owner\/go\/need-masto/);
  const html = await (await get('/owner')).text();
  assert.match(html, /Connect Mastodon/); assert.match(html, /Sign up first/);
  assert.equal((await get('/owner', 'us_session=forged.value')).status, 401);
});

test('an ask no one-click flow can satisfy is refused and becomes a staff item, never an owner card', async () => {
  const { ctx } = await mk();
  const r = await ask(ctx, 'SOME_OTHER_KEY', 'need-other');
  assert.equal(r.asked, false); assert.equal(r.reason, 'no_owner_link');
  assert.equal(ctx.db.raw.prepare('SELECT COUNT(*) n FROM gate_cards').get().n, 0);
  assert.equal(ctx.db.raw.prepare("SELECT status FROM items WHERE id = 'OWNERLINK-need-other'").get().status, 'blocked');
});

test('the database closes a permitted card filed without a link', async () => {
  const { ctx } = await mk();
  const raw = ctx.db.raw;
  raw.prepare("INSERT INTO access_state (capability, subject, status, probe_id, checked_at, expires_at, evidence) VALUES ('secret.available','Z','missing','p','2026-11-17T12:00:00.000Z','2099-01-01T00:00:00.000Z','[]')").run();
  raw.prepare("INSERT INTO access_routes (capability, subject, route, outcome, detail, at, probe_id) VALUES ('secret.available','Z','env','absent','x','2026-11-17T12:00:00.000Z','p')").run();
  raw.prepare("INSERT INTO access_permits (card_id, capability, subject, at) VALUES ('c1','secret.available','Z','2026-11-17T12:00:00.000Z')").run();
  raw.prepare("INSERT INTO gate_cards (id, what, why_gated, default_in_effect, closing_probe) VALUES ('c1','w','y','d','manual')").run();
  assert.equal(raw.prepare("SELECT status FROM gate_cards WHERE id='c1'").get().status, 'closed');
  assert.match(raw.prepare("SELECT reason FROM access_blocked_asks WHERE card_id='c1'").get().reason, /no_owner_link/);
});

test('Mastodon: register the app, authorize, callback stores the token, the card closes', async () => {
  const seen = [];
  const f = async (url, init = {}) => {
    seen.push(String(url)); const u = new URL(url);
    if (u.pathname === '/api/v1/apps') { assert.match(String(init.body), /redirect_uris=https%3A%2F%2Forg\.example%2Fowner%2Fcallback%2Fmastodon/); return resp(200, { client_id: 'cid12345', client_secret: 'csecret12345' }); }
    if (u.pathname === '/oauth/token') { assert.match(String(init.body), /code=thecode/); return resp(200, { access_token: 'tok-abcdefgh' }); }
    return resp(404, {});
  };
  const { ctx, get, vault, cookie } = await mk(f);
  await ask(ctx, 'MASTODON_TOKEN', 'need-masto');
  const go = await get('/owner/go/need-masto');
  assert.equal(go.status, 302);
  const loc = new URL(go.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://social.example/oauth/authorize');
  const state = loc.searchParams.get('state'), sc = go.headers.get('set-cookie').split(';')[0];
  assert.equal((await get(`/owner/callback/mastodon?code=thecode&state=${state}`)).status, 400, 'no state cookie: refused');
  const cb = await get(`/owner/callback/mastodon?code=thecode&state=${state}`, `${cookie}; ${sc}`);
  assert.equal(cb.status, 200); assert.match(await cb.text(), /Mastodon is connected/);
  assert.equal(await vault.read('MASTODON_TOKEN'), 'tok-abcdefgh');
  assert.equal(ctx.db.raw.prepare("SELECT status FROM gate_cards WHERE id='need-masto'").get().status, 'closed');
  assert.equal(ctx.db.raw.prepare("SELECT status FROM ownerlink_actions WHERE id='need-masto'").get().status, 'done');
  assert.equal((await get(`/owner/callback/mastodon?code=thecode&state=${state}`, `${cookie}; ${sc}`)).status, 400, 'a state is single use');
  assert.ok(seen.some(u => u.endsWith('/api/v1/apps')));
});

test('Bluesky: atproto OAuth with PKCE, PAR and DPoP stores the session; the client posts with a DPoP-bound token', async () => {
  const meta = { issuer: 'https://bsky.example', pushed_authorization_request_endpoint: 'https://bsky.example/par', authorization_endpoint: 'https://bsky.example/authorize', token_endpoint: 'https://bsky.example/token' };
  const calls = [];
  const f = async (url, init = {}) => {
    const u = String(url); calls.push(u); const hd = init.headers || {};
    if (u.endsWith('/.well-known/oauth-authorization-server')) return resp(200, meta);
    if (u === meta.pushed_authorization_request_endpoint) {
      assert.ok(hd.dpop, 'PAR carries a DPoP proof'); assert.match(String(init.body), /code_challenge_method=S256/);
      return hd.dpop.split('.').length === 3 && !calls.includes('nonce-sent') && (calls.push('nonce-sent'), true) ? resp(400, { error: 'use_dpop_nonce' }, { 'dpop-nonce': 'n1' }) : resp(201, { request_uri: 'urn:par:1' }, { 'dpop-nonce': 'n1' });
    }
    if (u === meta.token_endpoint) {
      if (String(init.body).includes('grant_type=authorization_code')) { assert.match(String(init.body), /code_verifier=/); return resp(200, { access_token: 'at-1', refresh_token: 'rt-1-long', sub: 'did:plc:abc123' }, { 'dpop-nonce': 'n1' }); }
      return resp(200, { access_token: 'at-2', refresh_token: 'rt-2-long', sub: 'did:plc:abc123' }, { 'dpop-nonce': 'n1' });
    }
    if (u === 'https://plc.directory/did:plc:abc123') return resp(200, { service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example' }] });
    if (u === 'https://pds.example/xrpc/com.atproto.repo.createRecord') { assert.equal(hd.authorization, 'DPoP at-2'); assert.ok(hd.dpop); assert.match(init.body, /hello world/); return resp(200, {}); }
    return resp(404, {});
  };
  const { ctx, get, vault, cookie } = await mk(f, { bluesky: { service: 'https://bsky.example' } });
  await ask(ctx, 'BLUESKY_OAUTH', 'need-bsky');
  const go = await get('/owner/go/need-bsky');
  assert.equal(go.status, 302);
  const loc = new URL(go.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://bsky.example/authorize'); assert.equal(loc.searchParams.get('request_uri'), 'urn:par:1');
  assert.equal(loc.searchParams.get('client_id'), ORIGIN + '/owner/atproto/client-metadata.json');
  const state = ctx.db.raw.prepare('SELECT state FROM ownerlink_state').get().state, sc = go.headers.get('set-cookie').split(';')[0];
  assert.equal((await get(`/owner/callback/bluesky?code=c1&state=${state}&iss=https://evil.example`, `${cookie}; ${sc}`)).status, 400, 'a different issuer is refused');
  const go2 = await get('/owner/go/need-bsky'); const st2 = ctx.db.raw.prepare('SELECT state FROM ownerlink_state').get().state;
  const cb = await get(`/owner/callback/bluesky?code=c1&state=${st2}&iss=https://bsky.example`, `${cookie}; ${go2.headers.get('set-cookie').split(';')[0]}`);
  assert.equal(cb.status, 200, await cb.clone().text());
  const saved = JSON.parse(await vault.read('BLUESKY_OAUTH'));
  assert.equal(saved.sub, 'did:plc:abc123'); assert.equal(saved.pds, 'https://pds.example'); assert.equal(saved.refresh_token, 'rt-1-long');
  await createBlueskyClient({ vault, fetch: f, now: () => T0 }).post('hello world');
  assert.equal(JSON.parse(await vault.read('BLUESKY_OAUTH')).refresh_token, 'rt-2-long', 'the rotated refresh token is written back');
  const m = await (await get('/owner/atproto/client-metadata.json', null)).json();
  assert.equal(m.dpop_bound_access_tokens, true); assert.equal(m.client_id, ORIGIN + '/owner/atproto/client-metadata.json');
});

test('pull requests waiting on a human reviewer become one-click actions and close when approved', async () => {
  const prs = [{ number: 239, title: 'idea intake', html_url: 'https://github.com/o/r/pull/239', draft: false, user: { login: 'bot' }, labels: [{ name: 'protected-change' }] },
    { number: 5, title: 'ordinary', html_url: 'https://github.com/o/r/pull/5', draft: false, user: { login: 'bot' }, labels: [] }];
  let reviews = [];
  const f = async url => { const p = String(url).replace('https://api.github.com', ''); if (p.startsWith('/repos/o/r/pulls?')) return resp(200, prs); if (p === '/repos/o/r/pulls/239/reviews?per_page=100') return resp(200, reviews); return resp(404, {}); };
  const { ol, get, ctx } = await mk(f, { prs: { repos: ['o/r'] } });
  assert.deepEqual((await ol.step()).prs, { open: 1, done: 0, unreadable: 0 });
  const body = await (await get('/api/owner/actions')).json();
  assert.equal(body.actions.length, 1); assert.equal(body.actions[0].link, 'https://github.com/o/r/pull/239/files');
  assert.equal((await get('/owner/go/' + encodeURIComponent('pr:o/r#239'))).headers.get('location'), 'https://github.com/o/r/pull/239/files');
  reviews = [{ user: { login: 'human' }, state: 'APPROVED' }];
  assert.equal((await ol.step()).prs.done, 1);
  assert.equal((await (await get('/api/owner/actions')).json()).actions.length, 0);
  void ctx;
});
