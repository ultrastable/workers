// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// socialChannel over the AT Protocol (Bluesky): createSession with an app password, createRecord, getPosts, deleteRecord.
// Credentials are read from env by NAME at call time, held only in this closure, and never stored, logged or put in an error.
import { linkFacets } from '../text.js';

export const SECRET_NAMES = ['BLUESKY_IDENTIFIER', 'BLUESKY_APP_PASSWORD'];
export const credentialsPresent = (env = {}, names = SECRET_NAMES) => ({ ok: names.every(n => !!env[n]), missing: names.filter(n => !env[n]) });

export function createBlueskyChannel({ fetch, env = {}, service, webBase, now = () => Date.now(), identifierEnv = SECRET_NAMES[0], passwordEnv = SECRET_NAMES[1] }) {
  if (!service) throw new Error('service (the PDS base URL) is required');
  const base = service.replace(/\/+$/, '');
  let session = null;

  async function xrpc(method, name, { body, query, auth = true } = {}) {
    const url = `${base}/xrpc/${name}${query ? `?${new URLSearchParams(query)}` : ''}`;
    const headers = { accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    if (auth) headers.authorization = `Bearer ${session.accessJwt}`;
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { res, data };
  }
  const fail = (what, res, data) => Object.assign(new Error(`${what} failed: HTTP ${res.status}${data?.error ? ` ${data.error}` : ''}`), { status: res.status });

  async function login() {
    const { ok, missing } = credentialsPresent(env, [identifierEnv, passwordEnv]);
    if (!ok) throw new Error(`credentials missing: ${missing.join(', ')}`);
    const { res, data } = await xrpc('POST', 'com.atproto.server.createSession', { body: { identifier: env[identifierEnv], password: env[passwordEnv] }, auth: false });
    if (!res.ok || !data?.accessJwt) throw fail('createSession', res, data);
    session = { accessJwt: data.accessJwt, did: data.did, handle: data.handle };
  }
  // One call with one transparent re-login when the token has expired.
  async function call(method, name, opts) {
    if (!session) await login();
    let r = await xrpc(method, name, opts);
    if (r.res.status === 401 || r.data?.error === 'ExpiredToken') { await login(); r = await xrpc(method, name, opts); }
    return r;
  }
  const rkey = uri => String(uri).split('/').pop();
  const webUrl = uri => `${(webBase || 'https://bsky.app').replace(/\/+$/, '')}/profile/${uri.split('/')[2]}/post/${rkey(uri)}`;

  async function getPost(uri) {
    const { res, data } = await call('GET', 'app.bsky.feed.getPosts', { query: { uris: uri } });
    if (!res.ok) throw fail('getPosts', res, data);
    return data?.posts?.[0] || null;
  }

  return {
    name: 'bluesky',
    async post({ text, links = [], replyTo }) {
      const record = { $type: 'app.bsky.feed.post', text, createdAt: new Date(now()).toISOString() };
      const facets = linkFacets(text).filter(f => !links.length || links.includes(f.features[0].uri));
      if (facets.length) record.facets = facets;
      if (replyTo) {
        const parent = typeof replyTo === 'string' ? await getPost(replyTo) : replyTo.parent;
        if (!parent) throw new Error('reply parent not found');
        const root = typeof replyTo === 'string' ? (parent.record?.reply?.root || { uri: parent.uri, cid: parent.cid }) : replyTo.root;
        record.reply = { root: { uri: root.uri, cid: root.cid }, parent: { uri: parent.uri, cid: parent.cid } };
      }
      if (!session) await login();
      const { res, data } = await call('POST', 'com.atproto.repo.createRecord', { body: { repo: session.did, collection: 'app.bsky.feed.post', record } });
      if (!res.ok || !data?.uri) throw fail('createRecord', res, data);
      return { id: data.uri, url: webUrl(data.uri) };
    },
    async fetchPost(id) {
      const p = await getPost(id);
      if (!p) return null;
      return {
        id: p.uri, cid: p.cid, url: webUrl(p.uri), text: p.record?.text, createdAt: p.record?.createdAt, state: 'published',
        metrics: { likes: p.likeCount || 0, reposts: p.repostCount || 0, replies: p.replyCount || 0, quotes: p.quoteCount || 0 },
      };
    },
    async remove(id) {
      if (!session) await login();
      const { res, data } = await call('POST', 'com.atproto.repo.deleteRecord', { body: { repo: session.did, collection: 'app.bsky.feed.post', rkey: rkey(id) } });
      if (!res.ok) throw fail('deleteRecord', res, data);
      return { ok: true };
    },
  };
}
