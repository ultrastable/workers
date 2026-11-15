// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// US-SPEC-18 section 8: the identity-aware proxy deployment guide as data that code runs and tests check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDb } from '../_shared/testdb.js';
import { createProxyGuide, verifyIapJwt, verifyProxy, proxyKind, HEADERS, IAP_KEYS_URL, IAP_ISSUER, _clearIapKeys } from './proxy.js';

const dir = p => fileURLToPath(new URL(p, import.meta.url));
const GUIDE = JSON.parse(readFileSync(dir('./proxy-guide.json'), 'utf8'));
const SRC = readFileSync(dir('./proxy.js'), 'utf8') + readFileSync(dir('../src/console.js'), 'utf8');
const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);
const AUD = '/projects/123456/global/backendServices/987654';
const b64u = b => Buffer.from(b).toString('base64url');
async function signer(kid = 'k1') {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const sign = async (claims, k = kid, key = kp.privateKey) => {
    const head = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: k })); const body = b64u(JSON.stringify(claims));
    return `${head}.${body}.${b64u(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${head}.${body}`))))}`;
  };
  return { kp, sign, jwks: { keys: [{ ...jwk, kid }] } };
}
const claims = (o = {}) => ({ iss: IAP_ISSUER, aud: AUD, iat: Math.floor(T0 / 1000) - 10, exp: Math.floor(T0 / 1000) + 600, email: 'ana@org.example', sub: 'accounts:1', ...o });

test('the guide is consumed by code: every step names a check the code implements, every header and setting it names is one the code reads', () => {
  const db = makeDb([]);
  const names = createProxyGuide({ db, guide: GUIDE }).checkNames();
  assert.deepEqual(Object.keys(GUIDE.proxies).sort(), Object.keys(HEADERS).sort());
  for (const [kind, p] of Object.entries(GUIDE.proxies)) {
    assert.equal(p.header, HEADERS[kind]);
    assert.ok(SRC.includes(`'${p.header}'`), `${p.header} is read by the code`);
    for (const key of p.config) assert.ok(p.steps.some(s => s.check === `config:${key}`), `${kind}: setting ${key} is checked by a step`);
    assert.ok(p.steps.some(s => s.check === 'inner:lock_present'), `${kind}: the inner lock is part of the guide`);
    for (const s of p.steps) {
      assert.ok(names.includes(s.check.split(':')[0]), `${kind}/${s.id}: check ${s.check} exists`);
      assert.ok(s.what && s.default_in_effect && ['person', 'system'].includes(s.who));
      assert.ok(!/\b(jwt|aud claim|backend service id|oauth)\b/i.test(s.what), 'plain words (US-18-R06)');
    }
  }
  assert.throws(() => createProxyGuide({ db }), /guide data/);
});

test('Google IAP header: valid, wrong audience, wrong issuer, expired, bad signature, unknown key, wrong algorithm', async () => {
  _clearIapKeys();
  const s = await signer(); const other = await signer();
  let fetches = 0;
  const fetch = async u => { fetches++; assert.equal(u, IAP_KEYS_URL); return Response.json(s.jwks); };
  const v = (t, now = T0) => verifyIapJwt(t, { audience: AUD, fetch, now });
  assert.deepEqual(await v(await s.sign(claims())), { ok: true, email: 'ana@org.example', sub: 'accounts:1' });
  await v(await s.sign(claims())); assert.equal(fetches, 1, 'keys are cached');
  assert.equal((await v(await s.sign(claims({ aud: '/projects/1/global/backendServices/2' })))).ok, false);
  assert.equal((await v(await s.sign(claims({ iss: 'https://evil.example' })))).ok, false);
  assert.equal((await v(await s.sign(claims({ exp: Math.floor(T0 / 1000) - 120 })))).ok, false);
  assert.equal((await v(await s.sign(claims({ iat: Math.floor(T0 / 1000) + 600 })))).ok, false);
  assert.equal((await v(await s.sign(claims(), 'k1', other.kp.privateKey))).ok, false);
  assert.equal((await v(await s.sign(claims(), 'unknown'))).ok, false);
  const none = `${b64u(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${b64u(JSON.stringify(claims()))}.`;
  assert.equal((await v(none)).ok, false); assert.equal((await v('')).ok, false); assert.equal((await v('a.b')).ok, false);
  assert.equal((await verifyIapJwt(await s.sign(claims()), { fetch, now: T0 })).ok, false, 'no audience configured means no trust');
});

test('verifyProxy picks the proxy from the settings and trusts only its signed header', async () => {
  _clearIapKeys();
  const s = await signer();
  const fetch = async () => Response.json(s.jwks);
  const config = { doors: { iap: { audience: AUD } } };
  assert.equal(proxyKind(config), 'google-iap'); assert.equal(proxyKind({ doors: { access: { team_domain: 't.example', aud: 'a' } } }), 'cloudflare-access'); assert.equal(proxyKind({}), null);
  const req = h => new Request('https://org.example/console', { headers: h });
  assert.equal((await verifyProxy(req({ 'x-goog-iap-jwt-assertion': await s.sign(claims()) }), config, { fetch, now: T0 })).email, 'ana@org.example');
  assert.equal((await verifyProxy(req({ 'x-goog-authenticated-user-email': 'accounts.google.com:ana@org.example' }), config, { fetch, now: T0 })).ok, false, 'an unsigned identity header is not trusted');
  assert.deepEqual(await verifyProxy(req({}), {}, { fetch, now: T0 }), { ok: false, kind: null });
});

test('status observes each step: settings filled in, an unauthenticated request refused at the edge, and the inner lock still on', async () => {
  const db = makeDb([]);
  const mk = (config, env, status) => createProxyGuide({ db, guide: GUIDE, config, env, now: () => T0, fetch: async (u, o) => { assert.equal(u, 'https://org.example/api/console'); assert.equal(o.redirect, 'manual'); return new Response(null, { status }); } });
  const none = await mk({}, {}, 200).status();
  assert.equal(none.configured, false); assert.equal(none.ready, false);
  const half = await mk({ public_origin: 'https://org.example', doors: { proxy: { intended: 'cloudflare-access' }, access: { team_domain: 'team.example' } } }, {}, 200).status();
  assert.deepEqual(half.steps.map(s => [s.id, s.done]), [['application', true], ['policy', false], ['outer_lock', false], ['inner_lock', false]]);
  assert.match(half.steps[2].detail, /got 200/);
  const full = await mk({ public_origin: 'https://org.example', doors: { access: { team_domain: 'team.example', aud: 'abc' } } }, { CONSOLE_TOKEN: true }, 302).status();
  assert.equal(full.ready, true); assert.equal(full.header, 'cf-access-jwt-assertion');
  const leaky = await mk({ public_origin: 'https://org.example', doors: { access: { team_domain: 'team.example', aud: 'abc' } } }, { CONSOLE_TOKEN: 'the-value-itself' }, 302).status();
  assert.equal(leaky.steps.at(-1).done, false, 'the presence map holds booleans; a value is not accepted');
  const iap = await mk({ public_origin: 'https://org.example', doors: { iap: { audience: AUD } } }, { GITHUB_APP_CLIENT_ID: true }, 200).status();
  assert.deepEqual(iap.steps.map(s => [s.id, s.done]), [['load_balancer', true], ['ingress', false], ['inner_lock', true]]);
});

test('US-18-R09: steps a person must do are decision cards that close when the step is observed done, never by the console setting anything', async () => {
  const db = makeDb([]);
  const config = { public_origin: 'https://org.example', doors: { proxy: { intended: 'cloudflare-access' } } };
  let edge = 200;
  const g = () => createProxyGuide({ db, guide: GUIDE, config, env: { CONSOLE_TOKEN: true }, now: () => T0, fetch: async () => new Response(null, { status: edge }) });
  assert.deepEqual(await g().sweep(), { opened: 2, closed: 0, reopened: 0, ready: false });
  assert.deepEqual(await g().sweep(), { opened: 0, closed: 0, reopened: 0, ready: false });
  const cards = db.raw.prepare(`SELECT id, what, default_in_effect, closing_probe, status FROM gate_cards ORDER BY id`).all();
  assert.deepEqual(cards.map(c => c.id), ['proxy-cloudflare-access-application', 'proxy-cloudflare-access-policy']);
  assert.ok(cards.every(c => c.default_in_effect && c.closing_probe.startsWith('proxy:cloudflare-access:')));
  db.raw.exec(`UPDATE gate_cards SET status='closed' WHERE id='proxy-cloudflare-access-policy'`); // "I did it" pressed, but it is not done
  assert.equal((await g().sweep()).reopened, 1);
  config.doors.access = { team_domain: 'team.example', aud: 'abc' }; edge = 403;
  assert.deepEqual(await g().sweep(), { opened: 0, closed: 2, reopened: 0, ready: true });
  assert.equal(db.raw.prepare(`SELECT COUNT(*) AS n FROM gate_cards WHERE status='open'`).get().n, 0);
  assert.equal(db.raw.prepare(`SELECT closed_at FROM gate_cards LIMIT 1`).get().closed_at, '2026-11-15 12:00:00');
});
