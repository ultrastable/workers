// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Mastodon in one click (OWNERLINK-1): register an OAuth app on the instance through its API, send the owner to authorize, take the
// code on the callback, store the access token in the vault as MASTODON_TOKEN. Nobody copies a value.
import { newState, takeState, complete } from './actions.js';

const SCOPE = 'write:statuses';
const form = o => new URLSearchParams(o);
const base = (ctx, action) => {
  const host = String(action.detail?.instance || ctx.config?.ownerlink?.mastodon?.instance || 'mastodon.social').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) throw new Error('instance host not valid');
  return 'https://' + host;
};
export const signupLink = (ctx, action) => base(ctx, action) + '/auth/sign_up';

export async function start(h, action, origin) {
  const b = base(h, action), redirect = origin + '/owner/callback/mastodon';
  let id = await h.vault.read('MASTODON_CLIENT_ID'), secret = await h.vault.read('MASTODON_CLIENT_SECRET'), inst = await h.vault.read('MASTODON_INSTANCE');
  if (!id || !secret || inst !== b) {
    const r = await h.fetch(b + '/api/v1/apps', { method: 'POST', body: form({ client_name: h.config?.ownerlink?.app_name || 'Ultrastable', redirect_uris: redirect, scopes: SCOPE, website: origin }) });
    const j = r.ok ? await r.json() : null;
    if (!j?.client_id || !j?.client_secret) return { error: `${b} would not register the app (HTTP ${r.status}). The instance may not allow it.` };
    await h.vault.put('MASTODON_CLIENT_ID', j.client_id, { by: 'ownerlink' }); await h.vault.put('MASTODON_CLIENT_SECRET', j.client_secret, { by: 'ownerlink' }); await h.vault.put('MASTODON_INSTANCE', b, { by: 'ownerlink' });
    id = j.client_id;
  }
  const state = await newState(h, action.id, 'mastodon', { base: b });
  return { state, redirect: `${b}/oauth/authorize?` + form({ response_type: 'code', client_id: id, redirect_uri: redirect, scope: SCOPE, state }) };
}

export async function callback(h, url, origin) {
  const st = await takeState(h, url.searchParams.get('state'), 'mastodon');
  const code = url.searchParams.get('code');
  if (!st || !code) return { error: 'That sign-in could not be matched. Start again from the owner page.' };
  const id = await h.vault.read('MASTODON_CLIENT_ID'), secret = await h.vault.read('MASTODON_CLIENT_SECRET');
  const r = await h.fetch(st.data.base + '/oauth/token', { method: 'POST', body: form({ grant_type: 'authorization_code', client_id: id, client_secret: secret, redirect_uri: origin + '/owner/callback/mastodon', code, scope: SCOPE }) });
  const j = r.ok ? await r.json() : null;
  if (!j?.access_token) return { error: `Mastodon refused the code (HTTP ${r.status}).` };
  const put = await h.vault.put('MASTODON_TOKEN', j.access_token, { by: 'ownerlink' });
  if (put.error) return { error: 'The token could not be stored.' };
  await complete(h, st.action_id);
  return { ok: 'Mastodon is connected. Posting starts on the next promotion run.' };
}
