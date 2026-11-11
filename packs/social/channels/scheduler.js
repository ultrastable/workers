// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// socialChannel over a Buffer-style scheduler API: create an update for a profile, read it back, list pending, delete.
// The base URL, profile id and paths come from configuration; the access token is read from env by name and sent as a bearer
// header (never in a URL). Paths default to the documented Buffer v1 shape and can be overridden.
export const SECRET_NAMES = ['SCHEDULER_ACCESS_TOKEN'];
const DEFAULT_PATHS = {
  create: '/updates/create.json',
  get: '/updates/{id}.json',
  pending: '/profiles/{profile}/updates/pending.json',
  destroy: '/updates/{id}/destroy.json',
};

export function createSchedulerChannel({ fetch, env = {}, baseUrl, profileId, tokenEnv = SECRET_NAMES[0], paths = {}, shareNow = false }) {
  if (!baseUrl || !profileId) throw new Error('baseUrl and profileId are required');
  const base = baseUrl.replace(/\/+$/, '');
  const P = { ...DEFAULT_PATHS, ...paths };
  const url = (key, vars = {}) => base + Object.entries(vars).reduce((p, [k, v]) => p.replace(`{${k}}`, encodeURIComponent(v)), P[key]);

  async function call(method, u, form) {
    const token = env[tokenEnv];
    if (!token) throw new Error(`credentials missing: ${tokenEnv}`);
    const res = await fetch(u, {
      method, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new Error(`scheduler request failed: HTTP ${res.status}${data?.message ? ` ${String(data.message).slice(0, 80)}` : ''}`);
    return data;
  }
  const state = u => (u.status === 'sent' || u.sent_at || u.service_link ? 'published' : 'pending');

  return {
    name: 'scheduler',
    async post({ text, replyTo }) {
      if (replyTo) throw new Error('this scheduler channel does not support replies');
      const form = { text, 'profile_ids[]': profileId };
      if (shareNow) form.now = 'true';
      const data = await call('POST', url('create'), form);
      const u = data?.updates?.[0] || data?.update;
      if (!data?.success && !u) throw new Error('scheduler did not confirm the update');
      return { id: String(u.id), url: u.service_link || null };
    },
    async fetchPost(id) {
      let u;
      try { u = await call('GET', url('get', { id })); } catch (e) { if (/HTTP 404/.test(e.message)) return null; throw e; }
      if (!u || !u.id) return null;
      const st = u.statistics || {};
      return { id: String(u.id), url: u.service_link || null, text: u.text, state: state(u), metrics: { likes: st.favorites ?? st.likes ?? 0, reposts: st.retweets ?? st.reposts ?? 0, replies: st.mentions ?? st.replies ?? 0 } };
    },
    async pending() {
      const data = await call('GET', url('pending', { profile: profileId }));
      return (data?.updates || []).map(u => ({ id: String(u.id), text: u.text, due_at: u.due_at ?? null }));
    },
    async remove(id) {
      await call('POST', url('destroy', { id }), {});
      return { ok: true };
    },
  };
}
