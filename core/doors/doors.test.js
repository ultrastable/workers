// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Console doors (US-SPEC-18/19): first-run key, Access SSO, paste-a-secret, vault-satisfied runner needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { handleConsole } from '../src/console.js';
import { createVault } from '../vault/index.js';
import { verifyAccessJwt, _clearJwksCache } from './index.js';
import { runnerNeeds, createOrg } from '../org/index.js';

const dir = p => fileURLToPath(new URL(p, import.meta.url));
const MIGS = [dir('../vault/migrations/'), dir('./migrations/')];
const U = 'https://x.example';
const T0 = Date.parse('2026-11-11T00:00:00Z');
const newDb = (tick = true) => {
  const db = makeDb(MIGS);
  if (tick) db.raw.exec(`INSERT INTO tick_runs (started_at,finished_at,steps_completed,steps_total,report) VALUES ('2026-11-11T00:00:00Z','2026-11-11T00:00:01Z',1,1,'ok')`);
  return db;
};
const post = (path, body, { cookie, origin = U, json = true } = {}) => new Request(U + path, {
  method: 'POST', headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(json ? { 'content-type': 'application/json' } : {}) },
  body: json ? JSON.stringify(body) : body,
});
const keyFrom = html => html.match(/id=k readonly value="([^"]+)"/)[1];
const opts = (db, extra = {}) => ({ vault: createVault({ db }), doors: {}, now: () => T0 + 60e3, ...extra });

test('first-run page issues a key exactly once and stores only its hash', async () => {
  const db = newDb(); const o = opts(db); const env = { DB: db };
  const get = await handleConsole(new Request(U + '/console'), env, o);
  assert.equal(get.status, 200); assert.match(await get.text(), /Create my key/);
  assert.equal((await handleConsole(post('/console/first-run', null, { origin: null, json: false }), env, o)).status, 403);
  assert.equal((await handleConsole(post('/console/first-run', null, { origin: 'https://evil.example', json: false }), env, o)).status, 403);
  const res = await handleConsole(post('/console/first-run', null, { json: false }), env, o);
  assert.equal(res.status, 200);
  const html = await res.text(); const key = keyFrom(html);
  assert.match(html, /shown once/i); assert.match(html, /Copy/);
  assert.ok(key.length >= 43);
  const ck = res.headers.get('set-cookie'); assert.match(ck, /HttpOnly/);
  const row = db.raw.prepare('SELECT * FROM doors_first_run').get();
  assert.match(row.key_hash, /^[0-9a-f]{64}$/); assert.ok(row.issued_at);
  assert.ok(!JSON.stringify(db.raw.prepare('SELECT * FROM doors_first_run').all()).includes(key));
  // the cookie signs the person in
  const cookie = ck.split(';')[0];
  assert.equal((await handleConsole(new Request(U + '/api/console', { headers: { cookie } }), env, o)).status, 200);
  // second visitor: page gone, no second key
  const again = await handleConsole(post('/console/first-run', null, { json: false }), env, o);
  assert.equal(again.status, 404);
  const visit = await handleConsole(new Request(U + '/console'), env, o);
  assert.equal(visit.status, 401); assert.match(await visit.text(), /Access key/);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM doors_first_run').get().n, 1);
  // login with the issued key works; a wrong key fails
  const ok = await handleConsole(post('/console/login', new URLSearchParams({ key }), { json: false }), env, o);
  assert.equal(ok.status, 303);
  const bad = await handleConsole(post('/console/login', new URLSearchParams({ key: key + 'x' }), { json: false }), env, o);
  assert.equal(bad.status, 401);
  const none = await handleConsole(post('/console/login', new URLSearchParams({ key: '' }), { json: false }), env, o);
  assert.equal(none.status, 401);
});

test('an expired first-run window leaves the console off and files one card', async () => {
  const db = newDb(); const env = { DB: db };
  const o = opts(db, { now: () => T0 + 61 * 60e3 });
  assert.equal((await handleConsole(new Request(U + '/console'), env, o)).status, 503);
  assert.equal((await handleConsole(post('/console/first-run', null, { json: false }), env, o)).status, 503);
  await handleConsole(new Request(U + '/console'), env, o);
  const cards = db.raw.prepare(`SELECT what FROM gate_cards WHERE what LIKE 'first-run window expired%'`).all();
  assert.equal(cards.length, 1); assert.match(cards[0].what, /reset from the host/);
  assert.equal(db.raw.prepare('SELECT key_hash FROM doors_first_run').get().key_hash, null);
});

test('console is off before the first tick, and off when no door is configured', async () => {
  const db = newDb(false);
  assert.equal((await handleConsole(new Request(U + '/console'), { DB: db }, opts(db))).status, 503);
  const db2 = newDb();
  assert.equal((await handleConsole(new Request(U + '/console'), { DB: db2 }, { vault: createVault({ db: db2 }) })).status, 503);
  assert.equal(db2.raw.prepare('SELECT COUNT(*) AS n FROM doors_first_run').get().n, 0);
});

// ---- Access JWT ----
const b64u = b => Buffer.from(b).toString('base64url');
const TEAM = 'team.example.test', AUD = 'aud-123';
async function signer() {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const sign = async (claims, kid = 'k1', key = kp.privateKey) => {
    const h = b64u(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })), c = b64u(JSON.stringify(claims));
    return `${h}.${c}.${b64u(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${c}`))))}`;
  };
  return { kp, sign, jwks: { keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] } };
}
const base = (now, over = {}) => ({ iss: `https://${TEAM}`, aud: [AUD], exp: Math.floor(now / 1000) + 600, nbf: Math.floor(now / 1000) - 10, ...over });

test('Access JWT: valid, expired, wrong aud, wrong iss, bad signature, unknown kid, skew', async () => {
  _clearJwksCache();
  const s = await signer(); const other = await signer();
  let fetches = 0;
  const fetch = async u => { fetches++; assert.equal(u, `https://${TEAM}/cdn-cgi/access/certs`); return Response.json(s.jwks); };
  const now = T0; const v = (t, n = now) => verifyAccessJwt(t, { team_domain: TEAM, aud: AUD, fetch, now: n });
  assert.equal(await v(await s.sign(base(now))), true);
  assert.equal(await v(await s.sign(base(now))), true);
  assert.equal(fetches, 1, 'keys are cached');
  assert.equal(await v(await s.sign(base(now, { aud: 'nope' }))), false);
  assert.equal(await v(await s.sign(base(now, { iss: 'https://evil.example' }))), false);
  assert.equal(await v(await s.sign(base(now, { exp: Math.floor(now / 1000) - 120 }))), false);
  assert.equal(await v(await s.sign(base(now, { exp: Math.floor(now / 1000) - 30 }))), true, 'within 60s skew');
  assert.equal(await v(await s.sign(base(now, { nbf: Math.floor(now / 1000) + 300 }))), false);
  assert.equal(await v(await s.sign(base(now), 'k1', other.kp.privateKey)), false, 'bad signature');
  assert.equal(await v(await s.sign(base(now), 'unknown')), false, 'unknown kid');
  assert.equal(await v('not.a.jwt'), false); assert.equal(await v(''), false); assert.equal(await v(null), false);
  const t = await s.sign(base(now));
  assert.equal(await v(t, now + 2 * 3600e3), false, 'expired by then');
});

test('Access SSO authenticates /console and /api/console; an unverified header does not', async () => {
  _clearJwksCache();
  const s = await signer(); const db = newDb();
  const fetch = async () => Response.json(s.jwks);
  const o = opts(db, { doors: { access: { team_domain: TEAM, aud: AUD } }, fetch });
  const env = { DB: db };
  const good = await s.sign(base(T0 + 60e3));
  const forged = await (await signer()).sign(base(T0 + 60e3));
  assert.equal((await handleConsole(new Request(U + '/api/console', { headers: { 'cf-access-jwt-assertion': good } }), env, o)).status, 200);
  assert.equal((await handleConsole(new Request(U + '/console', { headers: { 'cf-access-jwt-assertion': good } }), env, o)).status, 200);
  assert.equal((await handleConsole(new Request(U + '/api/console', { headers: { 'cf-access-jwt-assertion': forged } }), env, o)).status, 401);
  assert.equal((await handleConsole(new Request(U + '/api/console'), env, o)).status, 401);
  assert.equal((await handleConsole(post('/api/console/ask', { text: 'hi' }, { origin: 'https://evil.example' }), env, o)).status, 401);
  const w = new Request(U + '/api/console/ask', { method: 'POST', headers: { 'cf-access-jwt-assertion': good, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"text":"hi"}' });
  assert.equal((await handleConsole(w, env, o)).status, 403);
  // Access configured: the first-run door stays closed
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM doors_first_run').get().n, 0);
});

// ---- paste a secret ----
const SECRET = 'sk-test-0123456789abcdef';
test('secret save returns no value, later reads never contain it, bad names and cross-origin are refused', async () => {
  const db = newDb(); const o = opts(db, { envNames: {} });
  const env = { DB: db, CONSOLE_TOKEN: 'correct-horse' };
  const login = await handleConsole(post('/console/login', new URLSearchParams({ key: 'correct-horse' }), { json: false }), env, o);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const save = async (name, value, extra) => handleConsole(post('/api/console/secret', { name, value }, { cookie, ...extra }), env, o);
  const before = await (await handleConsole(new Request(U + '/api/console', { headers: { cookie } }), env, o)).json();
  assert.deepEqual(before.connections.map(c => [c.name, c.present]), [['ANTHROPIC_API_KEY', false], ['VCS_TOKEN', false]]);
  const r = await save('ANTHROPIC_API_KEY', SECRET);
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { name: 'ANTHROPIC_API_KEY', stored: true });
  assert.equal((await save('NOT_ALLOWED_NAME', SECRET)).status, 400);
  assert.equal((await save('ANTHROPIC_API_KEY', 'short')).status, 400);
  assert.equal((await save('ANTHROPIC_API_KEY', SECRET, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await save('ANTHROPIC_API_KEY', SECRET, { origin: null })).status, 403);
  const after = await handleConsole(new Request(U + '/api/console', { headers: { cookie } }), env, o);
  const text = await after.text();
  assert.ok(!text.includes(SECRET));
  const c = JSON.parse(text).connections.find(x => x.name === 'ANTHROPIC_API_KEY');
  assert.equal(c.present, true); assert.ok(c.set_at); assert.deepEqual(Object.keys(c).sort(), ['help', 'label', 'name', 'present', 'set_at', 'source']);
  const page = await (await handleConsole(new Request(U + '/console', { headers: { cookie } }), env, o)).text();
  assert.ok(!page.includes(SECRET)); assert.match(page, /Connect/);
  // unauthenticated write refused
  assert.equal((await handleConsole(post('/api/console/secret', { name: 'VCS_TOKEN', value: SECRET }), env, o)).status, 401);
  // the value lives only in the vault table
  for (const t of db.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name)) {
    if (t === 'vault_secrets') continue;
    assert.ok(!JSON.stringify(db.raw.prepare(`SELECT * FROM "${t}"`).all()).includes(SECRET), t);
  }
});

test('a vault secret satisfies the runner needs at tick time; without it a card is filed', async () => {
  const config = { org_slug: 'demo', runner: { enabled: true }, vcs: { repo: 'o/r' }, router: { providers: { a: { key_env: 'ANTHROPIC_API_KEY' } } } };
  const fetch = async () => new Response('{}', { status: 500 });
  const empty = makeDb(MIGS);
  await createOrg({ db: empty, env: {}, config, fetch, now: () => T0 }).tick();
  assert.deepEqual(empty.raw.prepare("SELECT id FROM gate_cards WHERE id LIKE 'runner-needs-%' ORDER BY id").all().map(r => r.id), ['runner-needs-ANTHROPIC-API-KEY', 'runner-needs-VCS-TOKEN']);
  const filled = makeDb(MIGS); const vault = createVault({ db: filled });
  await vault.put('VCS_TOKEN', 'ghp-vault-token-1'); await vault.put('ANTHROPIC_API_KEY', SECRET);
  await createOrg({ db: filled, env: {}, config, fetch, now: () => T0 }).tick();
  assert.equal(filled.raw.prepare("SELECT COUNT(*) AS n FROM gate_cards WHERE id LIKE 'runner-needs-%'").get().n, 0);
  assert.deepEqual(runnerNeeds(config, await vault.withVault({})), []);
  for (const t of filled.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)) {
    if (t !== 'vault_secrets') assert.ok(!JSON.stringify(filled.raw.prepare('SELECT * FROM "' + t + '"').all()).includes(SECRET), t);
  }
});

test('the org serves the first-run door only when config.doors is present', async () => {
  for (const [doors, status] of [[undefined, 503], [{}, 200]]) {
    const db = makeDb(MIGS);
    const org = createOrg({ db, env: {}, config: { org_slug: 'demo', ...(doors ? { doors } : {}) }, fetch: async () => new Response('{}'), now: () => T0 });
    await org.tick();
    assert.equal((await org.handle(new Request(U + '/console'))).status, status);
  }
});
