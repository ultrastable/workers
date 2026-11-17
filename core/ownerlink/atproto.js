// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Bluesky through atproto OAuth (OWNERLINK-1): public client, PKCE S256, pushed authorization request, DPoP-bound tokens (ES256).
// The client metadata is served at /owner/atproto/client-metadata.json (its URL is the client_id). Tokens and the DPoP key live in the
// vault as one secret, BLUESKY_OAUTH. createBlueskyClient() refreshes and posts for the promoter, so no app password is needed.
import { newState, takeState, complete } from './actions.js';

const SCOPE = 'atproto transition:generic';
const enc = new TextEncoder();
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const form = o => new URLSearchParams(o);
const sha = async s => b64u(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const rnd = n => b64u(crypto.getRandomValues(new Uint8Array(n)));

export const clientId = origin => origin + '/owner/atproto/client-metadata.json';
export const clientMetadata = origin => ({
  client_id: clientId(origin), application_type: 'web', client_name: 'Ultrastable', client_uri: origin,
  redirect_uris: [origin + '/owner/callback/bluesky'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  scope: SCOPE, token_endpoint_auth_method: 'none', dpop_bound_access_tokens: true,
});

export async function newDpopKey() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return await crypto.subtle.exportKey('jwk', kp.privateKey);
}
export async function dpopProof(jwk, { method, url, nonce, token }) {
  const { kty, crv, x, y } = jwk;
  const head = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty, crv, x, y } };
  const u = new URL(url); u.search = ''; u.hash = '';
  const body = { jti: rnd(12), htm: method, htu: u.toString(), iat: Math.floor(Date.now() / 1000), ...(nonce ? { nonce } : {}), ...(token ? { ath: await sha(token) } : {}) };
  const input = b64u(enc.encode(JSON.stringify(head))) + '.' + b64u(enc.encode(JSON.stringify(body)));
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return input + '.' + b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(input)));
}
/** One request with a DPoP proof; one retry when the server hands out a nonce. box = { nonce }. */
export async function dpopFetch(doFetch, jwk, url, init = {}, box = {}, token) {
  const go = async () => doFetch(url, { ...init, headers: { ...(init.headers || {}), dpop: await dpopProof(jwk, { method: init.method || 'GET', url, nonce: box.nonce, token }), ...(token ? { authorization: 'DPoP ' + token } : {}) } });
  let r = await go();
  const n = r.headers?.get?.('dpop-nonce');
  if (n) { const changed = n !== box.nonce; box.nonce = n; if (changed && (r.status === 400 || r.status === 401)) r = await go(); }
  return r;
}

async function serverMeta(h, service) {
  const r = await h.fetch(service + '/.well-known/oauth-authorization-server');
  const j = r.ok ? await r.json() : null;
  return j?.issuer && j.pushed_authorization_request_endpoint && j.authorization_endpoint && j.token_endpoint ? j : null;
}
async function pdsOf(h, did) {
  if (!/^did:(plc|web):[A-Za-z0-9._:%-]+$/.test(did)) return null;
  const url = did.startsWith('did:plc:') ? 'https://plc.directory/' + did : 'https://' + did.slice(8).replace(/%3A/gi, ':') + '/.well-known/did.json';
  const r = await h.fetch(url); const j = r.ok ? await r.json() : null;
  return (j?.service || []).find(s => s.type === 'AtprotoPersonalDataServer' || String(s.id).endsWith('#atproto_pds'))?.serviceEndpoint || null;
}

export async function start(h, action, origin) {
  const service = String(h.config?.ownerlink?.bluesky?.service || 'https://bsky.social').replace(/\/+$/, '');
  const meta = await serverMeta(h, service);
  if (!meta) return { error: 'Bluesky authorization server could not be read.' };
  const verifier = rnd(48), jwk = await newDpopKey(), box = {};
  const state = await newState(h, action.id, 'bluesky', { verifier, jwk, issuer: meta.issuer, token_endpoint: meta.token_endpoint, box });
  const par = await dpopFetch(h.fetch, jwk, meta.pushed_authorization_request_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: clientId(origin), response_type: 'code', code_challenge: await sha(verifier), code_challenge_method: 'S256', state, redirect_uri: origin + '/owner/callback/bluesky', scope: SCOPE }) }, box);
  const j = par.ok ? await par.json() : null;
  if (!j?.request_uri) return { error: `Bluesky did not accept the request (HTTP ${par.status}).` };
  await h.db.prepare('UPDATE ownerlink_state SET data = ? WHERE state = ?').bind(JSON.stringify({ verifier, jwk, issuer: meta.issuer, token_endpoint: meta.token_endpoint, box }), state).run();
  return { state, redirect: meta.authorization_endpoint + '?' + form({ client_id: clientId(origin), request_uri: j.request_uri }) };
}

export async function callback(h, url, origin) {
  const st = await takeState(h, url.searchParams.get('state'), 'bluesky'), code = url.searchParams.get('code');
  if (!st || !code) return { error: 'That sign-in could not be matched. Start again from the owner page.' };
  if (url.searchParams.get('iss') && url.searchParams.get('iss') !== st.data.issuer) return { error: 'The answer came from a different server than asked.' };
  const { verifier, jwk, token_endpoint, box } = st.data;
  const r = await dpopFetch(h.fetch, jwk, token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'authorization_code', code, redirect_uri: origin + '/owner/callback/bluesky', client_id: clientId(origin), code_verifier: verifier }) }, box);
  const j = r.ok ? await r.json() : null;
  if (!j?.access_token || !j?.refresh_token || !/^did:/.test(j.sub || '')) return { error: `Bluesky refused the code (HTTP ${r.status}).` };
  const pds = await pdsOf(h, j.sub);
  if (!pds) return { error: 'The account server for that identity could not be found.' };
  const put = await h.vault.put('BLUESKY_OAUTH', JSON.stringify({ sub: j.sub, pds, refresh_token: j.refresh_token, issuer: st.data.issuer, token_endpoint, client_id: clientId(origin), jwk, nonce: box.nonce || null }), { by: 'ownerlink' });
  if (put.error) return { error: 'The session could not be stored.' };
  await complete(h, st.action_id);
  return { ok: 'Bluesky is connected. Posting starts on the next promotion run.' };
}

/** For the promoter: post(text) with a refreshed, DPoP-bound session. Rotated refresh tokens are written back to the vault. */
export function createBlueskyClient({ vault, fetch: doFetch, now = () => Date.now() }) {
  const clock = typeof now === 'function' ? now : () => now;
  return {
    async post(text, { langs = ['en'] } = {}) {
      const raw = await vault.read('BLUESKY_OAUTH');
      if (!raw) throw Object.assign(new Error('credentials missing'), { skip: true });
      const s = JSON.parse(raw), box = { nonce: s.nonce };
      const t = await dpopFetch(doFetch, s.jwk, s.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: s.client_id }) }, box);
      const tj = t.ok ? await t.json() : null;
      if (!tj?.access_token || tj.sub !== s.sub) throw new Error('bluesky refresh failed HTTP ' + t.status);
      await vault.put('BLUESKY_OAUTH', JSON.stringify({ ...s, refresh_token: tj.refresh_token || s.refresh_token, nonce: box.nonce || null }), { by: 'ownerlink' });
      const pbox = {};
      const r = await dpopFetch(doFetch, s.jwk, s.pds.replace(/\/+$/, '') + '/xrpc/com.atproto.repo.createRecord', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: s.sub, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text, createdAt: new Date(clock()).toISOString(), langs } }) }, pbox, tj.access_token);
      if (!r.ok) throw new Error('bluesky HTTP ' + r.status);
    },
  };
}
